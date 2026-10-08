use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub r#type: String,
    pub value: String,
    pub start: u32,
    pub end: u32,
}
