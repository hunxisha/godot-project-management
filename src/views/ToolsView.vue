<script setup lang="ts">
// 工具页 · 工具箱重做的**中转空壳**。
//
// 旧的「Godot 项目体检」是一个**产品**：一次扫树 → 18 个检查器共享 ctx → 结论汇成
// 一条按类别聚合的问题流 → 逐条处置。那套形态已被否掉（定位错了：要的是工具箱，
// 做成了体检报告控制台），判据层与产品层在第 0 批一并拆了。
// 保留下来的只有 `src/tools/parsers/` 与 `refIndex.ts` / `treeUtils.ts` —— 它们不属于体检,
// 是「怎么读懂 Godot 的项目文件」，第 1、2 批的两个新工具直接踩在上面。
//
// 为什么这里什么都不画：新形态是「一个工具一个独立页面 + 用户可装的工具插件」,
// 而它的形状要靠第 1 批的 manifest / 加载器 / 三段式才能立起来。现在摆一个假列表,
// 等于下一轮再返一次工（上一轮翻车的机制正是「接口没有真实使用者就先定形」）。
// 所以这一页只负责两件事：
//   ① 顶栏「工具」这个入口不断,其余 6 个页面的路由与状态一行不改;
//   ② 明说这一页在重做中,让人知道不是坏了。
//
// 设计、取舍与 35 项决策见 docs/toolkit-redesign-plan.md。
import EmptyState from '../components/EmptyState.vue'
</script>

<template>
  <div class="tools-shell">
    <EmptyState
      icon="wrench"
      title="工具箱 · 重做中"
      desc="旧的「项目体检」已下线。新形态是每个工具各占一页、可以自行安装插件的工具箱；实施分四批推进，本页会在第 1 批换上真正的工具列表。"
    />
  </div>
</template>

<style scoped>
/* 只给滚动容器:内容居中与留白都交给 EmptyState,不在这里另写一套尺寸 */
.tools-shell {
  height: 100%;
  overflow-y: auto;
}
</style>
