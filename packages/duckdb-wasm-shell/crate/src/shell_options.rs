use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = "ShellOptions")]
    pub type ShellOptions;
    #[wasm_bindgen(method, getter, js_name = "backgroundColor")]
    pub fn get_bg(this: &ShellOptions) -> String;
    #[wasm_bindgen(method, getter, js_name = "fontFamily")]
    pub fn get_font_family(this: &ShellOptions) -> String;
    #[wasm_bindgen(method, getter, js_name = "withWebGL")]
    pub fn with_webgl(this: &ShellOptions) -> bool;
    /// JS-supplied list of DuckDB extensions to silently `LOAD` at shell
    /// startup. Returned as a raw `JsValue` so the Rust consumer can handle
    /// `undefined` / wrong type gracefully and fall back to its built-in
    /// default. Conventionally a JS array of strings, or omitted entirely.
    #[wasm_bindgen(method, getter, js_name = "defaultExtensions")]
    pub fn get_default_extensions(this: &ShellOptions) -> JsValue;
}
