export const INLINE_LIMIT_BYTES = 50_000_000;
export const FILES_API_LIMIT_BYTES = 1_073_741_824;
// Meta Responses `store=true` (default) has ~20 MB persistence limit even when
// inline limit is 50 MB — a 24 MB base64 payload triggers HTTP 413
// "payload_too_large … with `store=true`". Keep inline only for small files
// and force Files API or `store:false` above this threshold.
export const STORE_SAFE_INLINE_BYTES = 15_000_000;
export const AUTOMATIC_UPLOAD_EXPIRY_SECONDS = 24 * 60 * 60;
export const EXPLICIT_UPLOAD_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
export const MIN_UPLOAD_EXPIRY_SECONDS = 3_600;
export const MAX_UPLOAD_EXPIRY_SECONDS = 2_592_000;
export const MAX_ANALYSIS_SOURCES = 50;
