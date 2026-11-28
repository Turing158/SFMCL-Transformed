//! Atomically put the engine into a kill-on-close job at CreateProcess time.
//! This also covers launcher crashes between spawning and storing the child.
use anyhow::{ensure, Context, Result};
use std::{
    ffi::OsStr,
    fs::File,
    io::Write,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    System::{JobObjects::*, Pipes::CreatePipe, Threading::*},
};

pub struct OwnedProcess {
    job: OwnedHandle,
    process: OwnedHandle,
}
fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            if ch == '"' { slashes * 2 + 1 } else { slashes },
        ));
        result.push(ch);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}
fn checked(ok: i32) -> Result<()> {
    if ok == 0 {
        Err(std::io::Error::last_os_error().into())
    } else {
        Ok(())
    }
}
struct Attributes {
    storage: Vec<usize>,
}
impl Attributes {
    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
    fn new() -> Result<Self> {
        let mut size = 0;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut size);
        }
        let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        unsafe {
            checked(InitializeProcThreadAttributeList(
                storage.as_mut_ptr().cast(),
                2,
                0,
                &mut size,
            ))?;
        }
        Ok(Self { storage })
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.ptr());
        }
    }
}
impl OwnedProcess {
    pub fn spawn(executable: &Path, rpc: u16, config: &str) -> Result<Self> {
        ensure!(config.len() < 16000, "联机配置过大");
        // No user strings appear in the command line. The pipe is the only place
        // the room credential is sent; stdout/stderr and file logging are disabled.
        let rpc = format!("127.0.0.1:{rpc}");
        Self::launch(
            executable,
            &[
                "-c",
                "-",
                "--disable-env-parsing",
                "-r",
                &rpc,
                "--rpc-portal-whitelist",
                "127.0.0.1/32",
                "--console-log-level",
                "off",
                "--file-log-level",
                "off",
            ],
            executable.parent().context("组件目录无效")?,
            config.as_bytes(),
            false,
            None,
        )
        .map(|(process, _)| process)
    }

    /// Capture only the component's output, never room credentials. Creation
    /// and job assignment are atomic, just as for the EasyTier engine.
    pub fn spawn_logged(executable: &Path, args: &[&str], cwd: &Path) -> Result<(Self, File)> {
        let (process, output) = Self::launch(executable, args, cwd, &[], true, None)?;
        Ok((process, output.context("无法读取隧道启动状态")?))
    }

    pub fn spawn_terracotta(
        executable: &Path,
        private_temp: &Path,
        handshake: &Path,
    ) -> Result<Self> {
        let args = ["--hmcl", handshake.to_str().context("陶瓦握手路径无效")?];
        Self::launch(
            executable,
            &args,
            private_temp,
            &[],
            false,
            Some(private_temp),
        )
        .map(|(process, _)| process)
    }

    fn launch(
        executable: &Path,
        args: &[&str],
        cwd: &Path,
        input_bytes: &[u8],
        capture: bool,
        private_temp: Option<&Path>,
    ) -> Result<(Self, Option<File>)> {
        let app = wide(executable);
        let arguments = std::iter::once(quote(&executable.to_string_lossy()))
            .chain(args.iter().map(|arg| quote(arg)))
            .collect::<Vec<_>>()
            .join(" ");
        let mut command = wide(arguments);
        let cwd = wide(cwd);
        let mut environment = Vec::new();
        let mut vars: Vec<_> = std::env::vars_os()
            .filter(|(key, _)| {
                let key = key.to_string_lossy().to_ascii_uppercase();
                if private_temp.is_some() && matches!(key.as_str(), "TMP" | "TEMP") {
                    return false;
                }
                !["ET_", "TUNNEL_", "CLOUDFLARED_", "CF_"]
                    .iter()
                    .any(|prefix| key.starts_with(prefix))
            })
            .collect();
        if let Some(path) = private_temp {
            for name in ["TMP", "TEMP"] {
                vars.push((name.into(), path.as_os_str().into()));
            }
        }
        vars.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
        for (key, value) in vars {
            environment.extend(key.encode_wide());
            environment.push(b'=' as u16);
            environment.extend(value.encode_wide());
            environment.push(0);
        }
        environment.push(0);
        unsafe {
            let raw_job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            ensure!(!raw_job.is_null(), "无法创建联机进程容器");
            let job = OwnedHandle::from_raw_handle(raw_job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            checked(SetInformationJobObject(
                raw_job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ))?;
            let security = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: std::ptr::null_mut(),
                bInheritHandle: 1,
            };
            let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
            checked(CreatePipe(&mut read, &mut write, &security, 65536))?;
            let input = OwnedHandle::from_raw_handle(read);
            let mut writer = File::from(OwnedHandle::from_raw_handle(write));
            checked(SetHandleInformation(write, HANDLE_FLAG_INHERIT, 0))?;
            let (output, reader) = if capture {
                let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
                checked(CreatePipe(&mut read, &mut write, &security, 0))?;
                let reader = File::from(OwnedHandle::from_raw_handle(read));
                let output = File::from(OwnedHandle::from_raw_handle(write));
                checked(SetHandleInformation(
                    reader.as_raw_handle(),
                    HANDLE_FLAG_INHERIT,
                    0,
                ))?;
                (output, Some(reader))
            } else {
                (File::options().write(true).open("NUL")?, None)
            };
            checked(SetHandleInformation(
                output.as_raw_handle(),
                HANDLE_FLAG_INHERIT,
                HANDLE_FLAG_INHERIT,
            ))?;
            let mut attrs = Attributes::new()?;
            let jobs = [raw_job];
            let handles = [input.as_raw_handle(), output.as_raw_handle()];
            checked(UpdateProcThreadAttribute(
                attrs.ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                jobs.as_ptr().cast(),
                std::mem::size_of_val(&jobs),
                std::ptr::null_mut(),
                std::ptr::null(),
            ))?;
            checked(UpdateProcThreadAttribute(
                attrs.ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                std::mem::size_of_val(&handles),
                std::ptr::null_mut(),
                std::ptr::null(),
            ))?;
            let mut startup: STARTUPINFOEXW = std::mem::zeroed();
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = input.as_raw_handle();
            startup.StartupInfo.hStdOutput = output.as_raw_handle();
            startup.StartupInfo.hStdError = output.as_raw_handle();
            startup.lpAttributeList = attrs.ptr();
            let mut info: PROCESS_INFORMATION = std::mem::zeroed();
            checked(CreateProcessW(
                app.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr().cast(),
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            ))
            .context("联机组件无法启动")?;
            let process = OwnedHandle::from_raw_handle(info.hProcess);
            drop(OwnedHandle::from_raw_handle(info.hThread));
            let owned = Self { job, process };
            writer.write_all(input_bytes)?;
            drop(writer);
            Ok((owned, reader))
        }
    }
    pub fn running(&self) -> bool {
        unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) == WAIT_TIMEOUT }
    }
    pub fn job_running(&self) -> Result<bool> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            checked(QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            ))?;
        }
        Ok(info.ActiveProcesses != 0)
    }

    pub fn owns_listener(&self, port: u16) -> Result<bool> {
        use windows_sys::Win32::{NetworkManagement::IpHelper::*, Networking::WinSock::AF_INET};
        // DWORD-aligned buffer for the variable-length Win32 table. Listener counts can
        // change between calls, so resize on ERROR_INSUFFICIENT_BUFFER.
        let mut table = vec![0u32; 128];
        loop {
            let mut size = (table.len() * 4) as u32;
            let result = unsafe {
                GetExtendedTcpTable(
                    table.as_mut_ptr().cast(),
                    &mut size,
                    0,
                    AF_INET.into(),
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                )
            };
            if result == ERROR_INSUFFICIENT_BUFFER {
                table.resize((size as usize).div_ceil(4), 0);
                continue;
            }
            ensure!(result == NO_ERROR, "无法检查陶瓦控制端口归属");
            let n = table[0] as usize;
            ensure!(
                n * std::mem::size_of::<MIB_TCPROW_OWNER_PID>() <= (table.len() - 1) * 4,
                "控制端口表无效"
            );
            let rows = unsafe {
                std::slice::from_raw_parts(table.as_ptr().add(1).cast::<MIB_TCPROW_OWNER_PID>(), n)
            };
            for row in rows {
                if row.dwLocalAddr.to_ne_bytes() != [127, 0, 0, 1]
                    || u16::from_be(row.dwLocalPort as u16) != port
                {
                    continue;
                }
                unsafe {
                    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, row.dwOwningPid);
                    if handle.is_null() {
                        return Ok(false);
                    }
                    let process = OwnedHandle::from_raw_handle(handle);
                    let mut belongs = 0;
                    checked(IsProcessInJob(
                        process.as_raw_handle(),
                        self.job.as_raw_handle(),
                        &mut belongs,
                    ))?;
                    return Ok(belongs != 0);
                }
            }
            return Ok(false);
        }
    }
    pub fn stop(&self) -> Result<()> {
        unsafe {
            checked(TerminateJobObject(self.job.as_raw_handle(), 0))?;
            ensure!(
                WaitForSingleObject(self.process.as_raw_handle(), 10000) == WAIT_OBJECT_0,
                "联机进程仍在退出，请稍后重试"
            );
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while self.job_running()? {
            ensure!(std::time::Instant::now() < deadline, "联机工作进程仍在退出");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Ok(())
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
