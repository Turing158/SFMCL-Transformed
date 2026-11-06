use super::*;
use windows::{
    core::{Error, HRESULT},
    Win32::{
        Foundation::{DV_E_FORMATETC, E_NOTIMPL},
        System::{
            Com::{IAdviseSink, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, STGMEDIUM_0},
            Memory::{GlobalAlloc, GMEM_MOVEABLE, GMEM_ZEROINIT},
        },
    },
};

#[implement(IDataObject)]
struct Source(Vec<(u16, Vec<u8>)>);

#[allow(non_snake_case)]
impl IDataObject_Impl for Source_Impl {
    fn GetData(&self, format: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        let format = unsafe { &*format };
        let bytes = &self
            .0
            .iter()
            .find(|(id, _)| *id == format.cfFormat)
            .ok_or_else(|| Error::from(DV_E_FORMATETC))?
            .1;
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len()) }?;
        let pointer = unsafe { GlobalLock(handle) };
        assert!(!pointer.is_null());
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast(), bytes.len());
        }
        let _ = unsafe { GlobalUnlock(handle) };
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: handle },
            ..Default::default()
        })
    }
    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn QueryGetData(&self, _: *const FORMATETC) -> HRESULT {
        E_NOTIMPL
    }
    fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, _: *mut FORMATETC) -> HRESULT {
        E_NOTIMPL
    }
    fn SetData(
        &self,
        _: *const FORMATETC,
        _: *const STGMEDIUM,
        _: BOOL,
    ) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn EnumFormatEtc(&self, _: u32) -> windows::core::Result<IEnumFORMATETC> {
        Err(E_NOTIMPL.into())
    }
    fn DAdvise(
        &self,
        _: *const FORMATETC,
        _: u32,
        _: Ref<'_, IAdviseSink>,
    ) -> windows::core::Result<u32> {
        Err(E_NOTIMPL.into())
    }
    fn DUnadvise(&self, _: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(E_NOTIMPL.into())
    }
}

fn wide(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain([0])
        .flat_map(u16::to_le_bytes)
        .collect()
}

fn read(formats: Vec<(u16, Vec<u8>)>) -> Option<Payload> {
    let source: IDataObject = Source(formats).into();
    read_payload(Some(&source))
}

const CARD: &str =
    "authlib-injector:yggdrasil-server:https%3A%2F%2Flittleskin.cn%2Fapi%2Fyggdrasil";

#[test]
fn reads_browser_unicode_and_url_formats() {
    for format in
        [
            CF_UNICODETEXT.0,
            unsafe { RegisterClipboardFormatW(w!("UniformResourceLocatorW")) } as u16,
        ]
    {
        assert!(
            matches!(read(vec![(format, wide(CARD))]), Some(Payload::Card(value)) if value == CARD)
        );
    }
    assert!(
        matches!(read(vec![(CF_TEXT.0, format!("{CARD}\0").into_bytes())]), Some(Payload::Card(value)) if value == CARD)
    );
}

#[test]
fn rejects_non_cards_and_malformed_or_oversized_storage() {
    assert!(read_payload(None).is_none());
    assert!(read(vec![]).is_none());
    for value in [
        "ordinary text",
        "https://littleskin.cn/user",
        "中文",
        "authlib-injector:other",
    ] {
        assert!(read(vec![(CF_UNICODETEXT.0, wide(value))]).is_none());
    }
    for bytes in [vec![0x41; 8], vec![0x00, 0xd8, 0, 0], vec![0; 32770]] {
        assert!(read(vec![(CF_UNICODETEXT.0, bytes)]).is_none());
    }
    assert!(is_card(&format!(
        "# comment\n{}\nLittleSkin",
        CARD.to_uppercase()
    )));
}

#[test]
fn file_payload_wins_over_text_and_preserves_unicode_paths() {
    // Win32 DROPFILES header followed by a double-NUL-terminated UTF-16 list.
    let mut bytes = vec![0; 20];
    bytes[..4].copy_from_slice(&20u32.to_le_bytes());
    bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
    bytes.extend(wide("C:\\整合包\\测试.zip\0D:\\Minecraft\\client\0"));
    let payload = read(vec![(CF_HDROP.0, bytes), (CF_UNICODETEXT.0, wide(CARD))]);
    let Some(Payload::Files(paths)) = payload else {
        panic!("file drag was not preserved")
    };
    assert_eq!(
        paths,
        vec![
            PathBuf::from("C:\\整合包\\测试.zip"),
            PathBuf::from("D:\\Minecraft\\client")
        ]
    );
    // A text drag after a file drag is decoded independently, without stale paths.
    assert!(matches!(
        read(vec![(CF_UNICODETEXT.0, wide(CARD))]),
        Some(Payload::Card(_))
    ));
}
