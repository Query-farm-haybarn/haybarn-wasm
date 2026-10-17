;; Hand-written emscripten side module exporting an immutable data global, which the loader must
;; relocate by __memory_base, and a mutable global, which it must pass through as is.
(module
  (@custom "dylink.0" (before first) "\01\04\10\02\00\00")
  (import "env" "memory" (memory 0))
  (import "env" "__memory_base" (global $mb i32))
  (global $f f64 (f64.const 1.5))
  (global $hb_data i32 (i32.const 8))
  (global $hb_mut (mut i32) (i32.const 5))
  (global $c i32 (global.get $mb))
  (export "hb_data" (global $hb_data))
  (export "hb_mut" (global $hb_mut))
  (func (export "hb_data_addr") (result i32) global.get $mb i32.const 8 i32.add)
  (func (export "hb_get_mut") (result i32) global.get $hb_mut)
  (func (export "hb_set_mut") (param i32) local.get 0 global.set $hb_mut)
)
