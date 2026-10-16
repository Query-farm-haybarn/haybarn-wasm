;; Side module that itself defines+exports a symbol the main module also exports (ODR/linkonce
;; duplicate) and imports it via GOT: the GOT entry must still resolve to the MAIN module's copy.
(module
  (@custom "dylink.0" (before first) "\01\04\00\00\00\00")
  (import "GOT.func" "duckdb_web_get_feature_flags" (global $g (mut i32)))
  (func $mine (export "duckdb_web_get_feature_flags") (result i32) i32.const 12345)
  (func (export "hb_dup_got") (result i32) global.get $g)
)
