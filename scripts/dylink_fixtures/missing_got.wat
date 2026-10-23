;; Side module with a required (non-weak) GOT.func import nobody provides: dlopen must fail.
(module
  (@custom "dylink.0" (before first) "\01\04\00\00\00\00")
  (import "GOT.func" "hb_definitely_missing_fn" (global $g (mut i32)))
  (func (export "hb_m") (result i32) global.get $g)
)
