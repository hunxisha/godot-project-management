// 测试专用出口:把 vue 暴露给 Node 里的渲染层测试。
//
// 为什么需要:build-bundle.mjs 会为每个入口单独打包,但 Rollup 把共享的 vue 提成了一个
// chunk(见 .gpm-test/out/vue.runtime.esm-bundler-*.js),所有入口 import 的是**同一个**
// vue 实例。于是测试可以通过这个出口拿到同一份 vue 去创建 ref,
// 这样被测组合式函数内部的 watch/computed 才能真正感知到变化。
//
// 只被 src/composables/__tests__/*.test.mjs 使用,不参与打包进插件。
export * from 'vue'
