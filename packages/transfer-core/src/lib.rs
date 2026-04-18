pub mod crypto;
pub mod frame;
pub mod hasher;

pub const DROPBEAM_MAGIC: u8 = 0xDB;
pub const PROTOCOL_VERSION: u8 = 1;

// ─── WASM bindings ────────────────────────────────────────────────────────
#[cfg(feature = "wasm")]
mod wasm_bindings {
    use wasm_bindgen::prelude::*;
    use crate::{crypto, frame, hasher};

    #[wasm_bindgen(start)]
    pub fn init_panic_hook() {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();
    }

    // ── Frame codec ──────────────────────────────────────────────────────

    #[wasm_bindgen]
    pub fn encode_frame(
        file_id: u32,
        chunk_index: u32,
        payload: &[u8],
        encrypted: bool,
        last: bool,
    ) -> Vec<u8> {
        frame::encode_frame(file_id, chunk_index, payload, encrypted, last)
    }

    #[wasm_bindgen]
    pub fn decode_frame_file_id(buf: &[u8]) -> Result<u32, JsValue> {
        frame::decode_frame(buf).map(|f| f.file_id).map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn decode_frame_chunk_index(buf: &[u8]) -> Result<u32, JsValue> {
        frame::decode_frame(buf).map(|f| f.chunk_index).map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn decode_frame_encrypted(buf: &[u8]) -> Result<bool, JsValue> {
        frame::decode_frame(buf).map(|f| f.encrypted).map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn decode_frame_last(buf: &[u8]) -> Result<bool, JsValue> {
        frame::decode_frame(buf).map(|f| f.last).map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn decode_frame_payload(buf: &[u8]) -> Result<Vec<u8>, JsValue> {
        frame::decode_frame(buf).map(|f| f.payload.to_vec()).map_err(|e| JsValue::from_str(&e))
    }

    // ── Hashing ──────────────────────────────────────────────────────────

    #[wasm_bindgen]
    pub fn sha256_hex(data: &[u8]) -> String {
        crypto::sha256_hex(data)
    }

    #[wasm_bindgen]
    pub struct Sha256Hasher(hasher::IncrementalHasher);

    #[wasm_bindgen]
    impl Sha256Hasher {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Sha256Hasher {
            Sha256Hasher(hasher::IncrementalHasher::new())
        }
        pub fn update(&mut self, data: &[u8]) {
            self.0.update(data);
        }
        pub fn finalize_hex(self) -> String {
            self.0.finalize_hex()
        }
    }

    // ── AES-GCM ──────────────────────────────────────────────────────────

    /// key_bytes must be exactly 32 bytes.
    #[wasm_bindgen]
    pub fn aes_gcm_encrypt(key_bytes: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsValue> {
        let key: [u8; 32] = key_bytes
            .try_into()
            .map_err(|_| JsValue::from_str("key must be 32 bytes"))?;
        crypto::aes_gcm_encrypt(&key, plaintext).map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn aes_gcm_decrypt(key_bytes: &[u8], framed: &[u8]) -> Result<Vec<u8>, JsValue> {
        let key: [u8; 32] = key_bytes
            .try_into()
            .map_err(|_| JsValue::from_str("key must be 32 bytes"))?;
        crypto::aes_gcm_decrypt(&key, framed).map_err(|e| JsValue::from_str(&e))
    }

    // ── Key derivation ───────────────────────────────────────────────────

    /// PBKDF2-HMAC-SHA256 (200k iterations). Returns raw 32-byte key.
    #[wasm_bindgen]
    pub fn pbkdf2_derive(passphrase: &[u8], salt: &[u8]) -> Vec<u8> {
        crypto::pbkdf2_derive(passphrase, salt).to_vec()
    }
}

// ─── Native (non-WASM) convenience re-exports ────────────────────────────
pub use crypto::{aes_gcm_decrypt, aes_gcm_encrypt, pbkdf2_derive, sha256_hex};
pub use frame::{decode_frame, encode_frame};
pub use hasher::IncrementalHasher;
