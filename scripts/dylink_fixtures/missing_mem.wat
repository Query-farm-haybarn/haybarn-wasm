;; Side module with a required GOT.mem import nobody provides: dlopen must fail.
(module
  (@custom "dylink.0" (before first) "\01\04\00\00\00\00")
  (import "GOT.mem" "hb_definitely_missing_data" (global $g (mut i32)))
  (func (export "hb_m2") (result i32) global.get $g)
)
