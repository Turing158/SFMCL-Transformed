use anyhow::{ensure, Context, Result};
use std::{net::SocketAddr, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn varint(mut value: u32, bytes: &mut Vec<u8>) {
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        bytes.push(byte | if value != 0 { 128 } else { 0 });
        if value == 0 {
            break;
        }
    }
}
async fn read_varint(reader: &mut (impl tokio::io::AsyncRead + Unpin)) -> Result<u32> {
    let mut value = 0;
    for shift in (0..35).step_by(7) {
        let byte = reader.read_u8().await?;
        ensure!(shift < 28 || byte & 0xf0 == 0, "游戏响应长度无效");
        value |= u32::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    anyhow::bail!("游戏响应长度无效")
}

/// A local forwarding listener can accept TCP while its remote world is gone.
/// Require a bounded Minecraft status response before declaring the world ready.
pub async fn ping(target: SocketAddr) -> Result<String> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut stream = tokio::net::TcpStream::connect(target).await?;
        let host = target.ip().to_string();
        let mut handshake = vec![0];
        varint(47, &mut handshake);
        varint(host.len() as u32, &mut handshake);
        handshake.extend(host.bytes());
        handshake.extend(target.port().to_be_bytes());
        handshake.push(1);
        let mut packet = vec![];
        varint(handshake.len() as u32, &mut packet);
        packet.extend(handshake);
        packet.extend([1, 0]);
        stream.write_all(&packet).await?;
        let length = read_varint(&mut stream).await? as usize;
        ensure!((3..=262144).contains(&length), "游戏响应过大或无效");
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes).await?;
        let mut body = bytes.as_slice();
        ensure!(
            read_varint(&mut body).await? == 0,
            "不是 Minecraft 状态响应"
        );
        let json_length = read_varint(&mut body).await? as usize;
        ensure!(json_length == body.len(), "游戏响应不完整");
        let value: serde_json::Value = serde_json::from_slice(body).context("游戏状态响应无效")?;
        let version = value["version"]["name"]
            .as_str()
            .context("未检测到 Minecraft 世界")?;
        ensure!(
            super::invitation::text_field(version, 128),
            "游戏版本信息无效"
        );
        Ok(version.to_owned())
    })
    .await
    .context("世界连接超时")?
}
