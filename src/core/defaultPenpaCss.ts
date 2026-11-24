export const DEFAULT_PENPA_MD3_CSS = `/* PenpaAnywhere — MD3 Dark 风格注入（自动跟随系统动态配色） */
:root {
  --bgPage: var(--md-sys-color-surface-container, #1d2024);
  --bgMain: var(--md-sys-color-surface-container-high, #282a2f);
  --bgHover: var(--md-sys-color-surface-container-highest, #33353a);
  --bgMedium: var(--md-sys-color-surface-container-low, #191c20);
  --fgMain: var(--md-sys-color-on-surface, #e2e2e9);
  --fgMedium: var(--md-sys-color-on-surface-variant, #c4c6d0);
  --fgSubtle: var(--md-sys-color-outline-variant, #44474f);
}

html,
body {
  background: var(--md-sys-color-surface-container, #1d2024) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  font-family: 'Segoe UI', Roboto, 'Noto Sans SC', system-ui, -apple-system, sans-serif !important;
}

#buttons {
  background: var(--md-sys-color-surface-container-low, #191c20) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 14px !important;
  box-shadow: none !important;
}

/* 顶部 / 底部操作按钮 */
#top_button button,
#bottom_button button,
.button,
#tab-dropdown-lite-btn,
.nb_button input[type="button"] {
  background: var(--md-sys-color-surface-container-high, #282a2f);
  color: var(--md-sys-color-on-surface, #e2e2e9);
  border: 1px solid var(--md-sys-color-outline-variant, #44474f);
  border-radius: 999px;
  padding: 2px 9px;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

#top_button button:hover,
#bottom_button button:hover,
.button:hover,
#tab-dropdown-lite-btn:hover,
.nb_button input[type="button"]:hover {
  background: var(--md-sys-color-surface-container-highest, #33353a);
  border-color: var(--md-sys-color-outline, #8e9099);
}

#tb_undo,
#tb_redo {
  color: var(--md-sys-color-on-surface, #e2e2e9);
}

#tb_undo:disabled,
#tb_redo:disabled {
  color: var(--md-sys-color-outline, #8e9099);
  opacity: 0.55;
}

/* 模式 / 子模式切换标签（保留颜色块和图标背景） */
.label_mode,
#sub_txt,
#style_txt,
#style_txt_rot,
#symmode_content,
#combimode_content,
.DM,
.label_nb {
  color: var(--md-sys-color-on-surface-variant, #c4c6d0);
}

.label,
.label_option {
  background-color: var(--md-sys-color-surface-container-high, #282a2f);
  color: var(--md-sys-color-on-surface, #e2e2e9);
  border: 1px solid var(--md-sys-color-outline-variant, #44474f);
  border-radius: 8px;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.label:hover,
.label_option:hover {
  background-color: var(--md-sys-color-surface-container-highest, #33353a);
  color: var(--md-sys-color-on-surface, #e2e2e9);
  border-color: var(--md-sys-color-outline, #8e9099);
}

.labelSu,
.labelL {
  border: 1px solid var(--md-sys-color-outline-variant, #44474f);
  border-radius: 7px;
}

/* 选中态 */
input[type="radio"]:checked + label.label,
input[type="radio"]:checked + label.label_option {
  background: var(--md-sys-color-primary-container, #0842a0);
  color: var(--md-sys-color-on-primary-container, #d3e3fd);
  border-color: var(--md-sys-color-primary, #a8c7fa);
  box-shadow: 0 0 0 1px var(--md-sys-color-primary, #a8c7fa);
}

input[type="radio"]:checked + label.labelL,
input[type="radio"]:checked + label.labelSu {
  border-color: var(--md-sys-color-primary, #a8c7fa) !important;
  box-shadow: 0 0 0 2px var(--md-sys-color-primary, #a8c7fa) !important;
}

/* 符号 / 组合下拉菜单 */
.nav li span,
.nav li ul li span {
  background: var(--md-sys-color-surface-container-high, #282a2f);
  color: var(--md-sys-color-on-surface, #e2e2e9);
  border: 1px solid var(--md-sys-color-outline-variant, #44474f);
  border-radius: 8px;
}

.nav > li:hover > span,
.nav > li li:hover > span {
  background: var(--md-sys-color-primary-container, #0842a0);
  color: var(--md-sys-color-on-primary-container, #d3e3fd);
  border-color: var(--md-sys-color-primary, #a8c7fa);
}

/* 弹窗、悬浮键盘与表单控件 */
.modal-content,
#modal-image-content,
#modal-save-content,
#modal-input-content,
#modal-load-content,
#modal-save-tag-content,
#modal-save2-content,
#float-key {
  background: var(--md-sys-color-surface-container, #1d2024) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 14px !important;
}

.modal-header,
.modal-subheader,
#float-key-header,
#float-key-body,
#float-key-menu,
#float-key-select {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
}

select,
input[type="text"],
input[type="number"],
textarea {
  background: var(--md-sys-color-surface-container-high, #282a2f);
  color: var(--md-sys-color-on-surface, #e2e2e9);
  border: 1px solid var(--md-sys-color-outline-variant, #44474f);
  border-radius: 8px;
  padding: 2px 6px;
}

/* Select2 (Constraints) & VanillaSelectBox (Tab/Enter) 下拉组件 */
.select2-container--default .select2-selection--single,
.select2-container--default .select2-selection--multiple,
.vsb-main button {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 8px !important;
}

.select2-container--default .select2-selection--single .select2-selection__rendered,
.vsb-main .title {
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
}

.select2-container--default .select2-selection--single .select2-selection__arrow b,
.vsb-main .caret {
  border-top-color: var(--md-sys-color-on-surface-variant, #c4c6d0) !important;
}

.select2-dropdown,
.vsb-menu {
  background: var(--md-sys-color-surface-container, #1d2024) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 10px !important;
}

.select2-results__option,
.vsb-menu li {
  background: transparent !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
}

.select2-container--default .select2-results__option--highlighted[aria-selected],
.vsb-menu li:hover,
.vsb-menu li.active {
  background: var(--md-sys-color-primary-container, #0842a0) !important;
  color: var(--md-sys-color-on-primary-container, #d3e3fd) !important;
}

#stop_watch,
#puzzleinfo,
#contestinfo,
#puzzletitle,
#puzzleauthor,
#puzzlesource,
#solution_check {
  color: var(--md-sys-color-primary, #a8c7fa);
}

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: var(--md-sys-color-outline-variant, #44474f);
  border-radius: 999px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--md-sys-color-outline, #8e9099);
}
`;
