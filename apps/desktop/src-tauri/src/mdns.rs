//! mDNS-SD device discovery — announces this instance and collects nearby peers.
//! Uses the `mdns-sd` crate (pure Rust, no system daemon needed).

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

const SERVICE_TYPE: &str = "_dropbeam._tcp.local.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NearbyDevice {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub peer_id: String,
    pub device_kind: String,
}

pub struct MdnsDiscovery {
    daemon: ServiceDaemon,
    pub devices: Arc<Mutex<HashMap<String, NearbyDevice>>>,
    pub tx: broadcast::Sender<Vec<NearbyDevice>>,
}

impl MdnsDiscovery {
    pub fn new() -> anyhow::Result<Self> {
        let daemon = ServiceDaemon::new()?;
        let devices: Arc<Mutex<HashMap<String, NearbyDevice>>> = Arc::new(Mutex::new(HashMap::new()));
        let (tx, _) = broadcast::channel(64);
        Ok(MdnsDiscovery { daemon, devices, tx })
    }

    /// Announce this instance on the local network.
    pub fn announce(&self, name: &str, port: u16, peer_id: &str, kind: &str) -> anyhow::Result<()> {
        let mut props = HashMap::new();
        props.insert("peer_id".into(), peer_id.into());
        props.insert("kind".into(), kind.into());
        props.insert("version".into(), "1".into());

        let hostname = gethostname::gethostname().to_string_lossy().to_string();
        let service = ServiceInfo::new(
            SERVICE_TYPE,
            name,
            &format!("{hostname}.local."),
            (),
            port,
            props,
        )?;
        self.daemon.register(service)?;
        Ok(())
    }

    /// Start browsing for peers; fires `tx` whenever the peer list changes.
    pub fn browse(&self) {
        let receiver = self.daemon.browse(SERVICE_TYPE).expect("browse");
        let devices = Arc::clone(&self.devices);
        let tx = self.tx.clone();

        std::thread::spawn(move || {
            while let Ok(event) = receiver.recv() {
                let changed = match event {
                    ServiceEvent::ServiceResolved(info) => {
                        let addrs = info.get_addresses();
                        let host = addrs.iter().next().map(|a| a.to_string()).unwrap_or_default();
                        let peer_id = info.get_property_val_str("peer_id").unwrap_or("").to_string();
                        let kind = info.get_property_val_str("kind").unwrap_or("unknown").to_string();
                        let dev = NearbyDevice {
                            name: info.get_fullname().to_string(),
                            host,
                            port: info.get_port(),
                            peer_id: peer_id.clone(),
                            device_kind: kind,
                        };
                        devices.lock().unwrap().insert(peer_id, dev);
                        true
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        let mut map = devices.lock().unwrap();
                        map.retain(|_, v| v.name != fullname);
                        true
                    }
                    _ => false,
                };
                if changed {
                    let list: Vec<_> = devices.lock().unwrap().values().cloned().collect();
                    let _ = tx.send(list);
                }
            }
        });
    }

    pub fn device_list(&self) -> Vec<NearbyDevice> {
        self.devices.lock().unwrap().values().cloned().collect()
    }
}
