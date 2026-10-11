<script setup lang="ts">
// 权限面明示(§6 R-1 缓解① / A-12 验收项)。
//
// 那句话的唯一来源是 `toolkit/scaffold.ts` 的 `PERMISSION_TEXT` —— 骨架模板注释、骨架 README、
// 这里的 UI 三处必须是同一句,改一处就要三处一起改,所以这里一个字都不重写。
// ⚠ 措辞红线(R-1③):不许出现任何「已沙箱 / 安全沙箱 / 隔离运行」式的暗示性写法。
// 「沙箱」「隔离」这两个词不是不能提,而是不能拿来暗示安全 —— 只允许出现在否定句里(下面那段就是),
// Task 13 的断言按行判这条。
import Icon from '../Icon.vue'
import { PERMISSION_TEXT } from '../../toolkit/scaffold'

withDefaults(defineProps<{ head?: string }>(), { head: '插件能做什么(这不是安全边界)' })
</script>

<template>
  <div class="perm">
    <div class="perm-head"><Icon name="shield-check" :size="14" /><span>{{ head }}</span></div>
    <p class="perm-text">{{ PERMISSION_TEXT }}</p>
    <p class="perm-more">
      框架挡的是「手滑的合法插件」:越界改动强制升为高风险并单独分组、写盘前先落备份、删除一律进回收站、
      动作账本记住每个文件的备份名以便还原。它挡不住恶意插件 —— 这里没有沙箱也没有隔离,
      装别人写的插件就等于把这台机器的权限交给它,只装你信任的。
    </p>
  </div>
</template>

<style scoped>
.perm {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--warn);
  border-radius: var(--radius);
  background: var(--surface-2);
}

.perm-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--warn);
  font-size: 12.5px;
  font-weight: 700;
}

.perm-text,
.perm-more {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.65;
}

.perm-text {
  color: var(--text);
}
</style>
