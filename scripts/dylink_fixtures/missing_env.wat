;; Side module with an env function import nobody provides: loads (lazy stub), fails when called.
(module
  (@custom "dylink.0" (before first) "\01\04\00\00\00\00")
  (import "env" "hb_definitely_missing_call" (func $f (result i32)))
  (func (export "hb_m3") (result i32) call $f)
)
