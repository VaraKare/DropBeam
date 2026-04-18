use sha2::{Digest, Sha256};

/// Incremental SHA-256 exposed as a stateful object.
pub struct IncrementalHasher {
    inner: Sha256,
}

impl IncrementalHasher {
    pub fn new() -> Self {
        IncrementalHasher { inner: Sha256::new() }
    }

    pub fn update(&mut self, data: &[u8]) {
        self.inner.update(data);
    }

    pub fn finalize_hex(self) -> String {
        hex::encode(self.inner.finalize())
    }
}
