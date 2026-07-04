// 模板克隆工具
"use strict";
export function clone(id) {
  const t = document.getElementById(id);
  return t && t.content.cloneNode(true);
}