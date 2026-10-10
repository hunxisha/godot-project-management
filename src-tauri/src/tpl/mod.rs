// 自编译模板链路的 Rust 侧(P0e)。与 JS 侧一一对应,**语义镜像**而不是另立判据:
// 每条判据的出处都在函数注释里点名 JS 文件的哪一段,漂移由 tests/tpl_parity.rs 逐字节照出来。
//
//   JS 真源                          →  Rust
//   tplprofile.js  (675 行,纯函数)   →  tpl/profile.rs
//   tplfeatures.js (109 行,能力表)   →  tpl/features.rs
//   tplprobe.js    (309 行,IO 注入)  →  tpl/probe.rs     (P0e-1 后半)
//   buildtools.js  (571 行,检测+编译) →  tpl/build.rs    (P0e-2)
//   tplsource.js   (220 行,代下载)   →  tpl/source.rs   (P0e-3)
//   tpllib.js      (342 行,模板库)   →  tpl/pack.rs     (P0e-4)
pub mod features;
pub mod probe;
pub mod profile;
