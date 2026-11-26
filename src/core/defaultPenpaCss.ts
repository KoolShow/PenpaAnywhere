export const DEFAULT_PENPA_MD3_CSS = `/* PenpaAnywhere — Material Design 3 Dark theme injection (follows dynamic OS/host tokens) */
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

p,
h1,
h2,
h3,
h4,
h5,
.values,
.DM,
.label_nb,
#save3texttitle,
#nb_note,
#answer_key {
  color: var(--md-sys-color-on-surface, #e2e2e9);
}

.modal-footnote {
  color: var(--md-sys-color-on-surface-variant, #c4c6d0);
}

a:link {
  color: var(--md-sys-color-primary, #a8c7fa);
}

a:visited {
  color: var(--md-sys-color-tertiary, #c4eed0);
}

a:hover,
a:active {
  color: var(--md-sys-color-secondary, #c2e7ff);
}

hr,
hr.newgridhrline {
  border: none;
  height: 1px;
  background: var(--md-sys-color-outline-variant, #44474f);
  margin: 6px 0;
}

/* Main control container & header */
header,
#header {
  background: var(--md-sys-color-surface-container-high, #282a2f);
  color: var(--md-sys-color-on-surface, #e2e2e9);
}

#page_help {
  background: var(--md-sys-color-secondary-container, #004a77);
  color: var(--md-sys-color-on-secondary-container, #c2e7ff);
  border: 1px solid var(--md-sys-color-outline-variant, #44474f);
  border-radius: 999px;
  text-decoration: none;
}

#buttons {
  background: var(--md-sys-color-surface-container-low, #191c20) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 14px !important;
  box-shadow: none !important;
}

.solving {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
}

/* Top / bottom / stopwatch / modal action buttons */
#top_button button,
#bottom_button button,
.button,
.button.sw,
#tab-dropdown-lite-btn,
#puzzlerules,
.nb_button input[type="button"],
#float-key-text input[type="button"],
#modal-save-content button,
#modal-save-content input[type="button"],
#modal-help-body a.button,
#settings-table button {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 999px !important;
  padding: 2px 10px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

#top_button button:hover,
#bottom_button button:hover,
.button:hover,
.button.sw:hover,
#tab-dropdown-lite-btn:hover,
#puzzlerules:hover,
.nb_button input[type="button"]:hover,
#float-key-text input[type="button"]:hover,
#modal-save-content button:hover,
#modal-save-content input[type="button"]:hover,
#modal-help-body a.button:hover,
#settings-table button:hover {
  background: var(--md-sys-color-surface-container-highest, #33353a) !important;
  border-color: var(--md-sys-color-outline, #8e9099) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
}

#tab-dropdown-lite-btn {
  border-radius: 8px !important;
}

#tb_undo,
#tb_redo {
  color: var(--md-sys-color-on-surface, #e2e2e9);
}

#tb_undo:disabled,
#tb_redo:disabled,
button:disabled,
input[type="button"]:disabled {
  color: var(--md-sys-color-outline, #8e9099) !important;
  opacity: 0.5;
  cursor: default;
}

.copied {
  background: var(--md-sys-color-tertiary-container, #0f5223) !important;
  color: var(--md-sys-color-on-tertiary-container, #c4eed0) !important;
  border-color: var(--md-sys-color-tertiary, #c4eed0) !important;
}

/* Grid resize directional buttons in Transform / Resize modals */
.existing-grid {
  background: var(--md-sys-color-surface-container-high, #282a2f);
  color: var(--md-sys-color-on-surface, #e2e2e9);
  border-color: var(--md-sys-color-outline, #8e9099);
  border-radius: 8px;
}

.resize-grid-buttons .addtop,
.resize-grid-buttons .addbottom,
.resize-grid-buttons .addleft,
.resize-grid-buttons .addright {
  background: var(--md-sys-color-tertiary-container, #0f5223);
  color: var(--md-sys-color-on-tertiary-container, #c4eed0);
  border: 1px solid var(--md-sys-color-tertiary, #c4eed0);
  border-radius: 8px;
}

.resize-grid-buttons .subtop,
.resize-grid-buttons .subbottom,
.resize-grid-buttons .subleft,
.resize-grid-buttons .subright {
  background: var(--md-sys-color-error-container, #8c1d18);
  color: var(--md-sys-color-on-error-container, #f9dedc);
  border: 1px solid var(--md-sys-color-error, #f2b8b5);
  border-radius: 8px;
}

/* Mode / sub-mode / style labels (preserves ID-styled color swatches and icon buttons) */
.label_mode,
#sub_txt,
#style_txt,
#style_txt_rot,
#symmode_content,
#combimode_content,
#visibility_button0,
#edge_button0,
#quick_panel_toggle_label,
#panel_buttons0,
#panel_buttonc0,
#resize_whitespace_button0 {
  color: var(--md-sys-color-on-surface-variant, #c4c6d0);
}

.label,
.label_option,
.labelSu,
.labelL,
.toggle_btn {
  background-color: var(--md-sys-color-surface-container-high, #282a2f);
  color: var(--md-sys-color-on-surface, #e2e2e9);
  border: 1px solid var(--md-sys-color-outline-variant, #44474f);
  border-radius: 8px;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

#visibility_button,
#edge_button,
#quick_panel_toggle,
#resize_whitespace_button {
  background-color: var(--md-sys-color-surface-container-high, #282a2f);
  color: var(--md-sys-color-on-surface, #e2e2e9);
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 8px;
  cursor: pointer;
}

.label:hover,
.label_option:hover,
.labelSu:hover,
.labelL:hover,
.toggle_btn:hover,
#visibility_button:hover,
#edge_button:hover,
#quick_panel_toggle:hover,
#resize_whitespace_button:hover {
  background-color: var(--md-sys-color-surface-container-highest, #33353a);
  color: var(--md-sys-color-on-surface, #e2e2e9);
  border-color: var(--md-sys-color-outline, #8e9099) !important;
}

/* Keep dark-ink bitmap icon buttons clearly legible in both dark and light themes */
#sub_number3_lb,
#sub_number9_lb,
#st_number0_lb,
#st_number6_lb,
#st_number7_lb,
#st_number11_lb {
  background-color: #e2e2e9;
}

/* Checked radio label states */
input[type="radio"]:checked + label.label,
input[type="radio"]:checked + label.label_option {
  background: var(--md-sys-color-primary-container, #0842a0);
  color: var(--md-sys-color-on-primary-container, #d3e3fd);
  border-color: var(--md-sys-color-primary, #a8c7fa);
  box-shadow: 0 0 0 1px var(--md-sys-color-primary, #a8c7fa);
}

/* Non-swatch .labelL / .labelSu get primary-container fill; ID-styled swatches keep their colors */
input[type="radio"]:checked + label.labelL,
input[type="radio"]:checked + label.labelSu {
  background-color: var(--md-sys-color-primary-container, #0842a0);
  color: var(--md-sys-color-on-primary-container, #d3e3fd);
  border-color: var(--md-sys-color-primary, #a8c7fa) !important;
  box-shadow: 0 0 0 2px var(--md-sys-color-primary, #a8c7fa) !important;
}

/* Shape & Composite cascading dropdown menus */
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

.nav li ul li ul::before {
  border-left-color: var(--md-sys-color-on-surface-variant, #c4c6d0);
}

.nav li.symbolmode_display span,
.nav > li.symbolmode_display:hover > span {
  background: transparent;
  border: none;
  color: var(--md-sys-color-on-surface-variant, #c4c6d0);
}

/* Modals, floating keypad panel, and backdrops */
.modal,
#modal-image,
#modal-bg-image,
#modal-save,
#modal-newsize,
#modal-input,
#modal-load,
#modal-keys,
#modal-save2,
#modal-save-tag,
#modal-replay {
  background-color: color-mix(in srgb, var(--md-sys-color-scrim, #000000) 56%, transparent) !important;
}

.modal-content,
#modal-image-content,
#modal-bg-image-content,
#modal-newsize-content,
#modal-rotate-content,
#modal-save-content,
#modal-save2-content,
#modal-save-tag-content,
#modal-replay-content,
#modal-input-content,
#modal-load-content,
#modal-settings-content,
#modal-keys-content,
#modal-help-content,
#float-key {
  background: var(--md-sys-color-surface-container, #1d2024) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 16px !important;
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.54) !important;
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

.modal-header {
  border-bottom: 1px solid var(--md-sys-color-outline-variant, #44474f);
  border-radius: 16px 16px 0 0 !important;
}

.modal-subheader {
  border-radius: 8px;
}

.panel_menu li + li,
.panel_menu_select li + li {
  border-color: var(--md-sys-color-outline-variant, #44474f);
}

#close-float-panel {
  color: var(--md-sys-color-on-surface-variant, #c4c6d0);
}

#close-float-panel:hover {
  color: var(--md-sys-color-on-surface, #e2e2e9);
  opacity: 1;
}

/* Settings, answer-check, and shortcuts tables */
#settings-table tr + tr td,
#modal-keys li + li {
  border-top-color: var(--md-sys-color-outline-variant, #44474f);
}

#answersetting {
  border: 2px solid var(--md-sys-color-outline, #8e9099);
}

#answersetting td {
  border: 1px solid var(--md-sys-color-outline-variant, #44474f);
}

#modal-keys kbd {
  background: var(--md-sys-color-surface-container-high, #282a2f);
  color: var(--md-sys-color-primary, #a8c7fa);
  border: 1px solid var(--md-sys-color-outline-variant, #44474f);
  border-radius: 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* Form controls */
select,
input[type="text"],
input[type="number"],
textarea,
#modal-save-content textarea,
#modal-save-content input[type="text"],
#settings-table select {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 8px !important;
  padding: 2px 6px;
}

select:focus,
input[type="text"]:focus,
input[type="number"]:focus,
textarea:focus {
  outline: none;
  border-color: var(--md-sys-color-primary, #a8c7fa) !important;
}

option {
  background: var(--md-sys-color-surface-container, #1d2024);
  color: var(--md-sys-color-on-surface, #e2e2e9);
}

input[type="checkbox"],
input[type="range"] {
  accent-color: var(--md-sys-color-primary, #a8c7fa);
}

/* Select2 (Constraints & Genre Tags) and VanillaSelectBox (Tab/Enter selector) */
.select2-container {
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
}

.select2-container--default .select2-selection--single,
.select2-container--default .select2-selection--multiple,
.vsb-main button {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 8px !important;
}

.select2-container--default .select2-selection--single .select2-selection__rendered,
.select2-container--default .select2-selection--multiple .select2-search__field,
.vsb-main .title {
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
}

.select2-container--default .select2-selection--single .select2-selection__placeholder {
  color: var(--md-sys-color-on-surface-variant, #c4c6d0) !important;
}

.select2-container--default .select2-selection--single .select2-selection__arrow b,
.vsb-main .caret {
  border-top-color: var(--md-sys-color-on-surface-variant, #c4c6d0) !important;
}

.select2-container--default.select2-container--open .select2-selection--single .select2-selection__arrow b {
  border-bottom-color: var(--md-sys-color-on-surface-variant, #c4c6d0) !important;
}

.select2-container--default .select2-selection--multiple .select2-selection__choice {
  background: var(--md-sys-color-secondary-container, #004a77) !important;
  color: var(--md-sys-color-on-secondary-container, #c2e7ff) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 6px !important;
}

.select2-container--default .select2-selection--multiple .select2-selection__choice__remove {
  color: var(--md-sys-color-on-secondary-container, #c2e7ff) !important;
}

.select2-dropdown,
.vsb-menu {
  background: var(--md-sys-color-surface-container, #1d2024) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 10px !important;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.48) !important;
}

.select2-search--dropdown .select2-search__field,
.vsb-js-search-zone,
.vsb-js-search-zone input {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border-color: var(--md-sys-color-outline-variant, #44474f) !important;
}

.vsb-menu ul {
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
}

.select2-results__option,
.vsb-menu li,
.vsb-menu .multi li {
  background: transparent !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
}

.select2-container--default .select2-results__option[aria-selected="true"] {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
}

.select2-container--default .select2-results__option--highlighted[aria-selected],
.vsb-menu li:hover,
.vsb-menu li.active,
.vsb-menu .multi li:hover,
.vsb-menu .multi li.active {
  background: var(--md-sys-color-primary-container, #0842a0) !important;
  color: var(--md-sys-color-on-primary-container, #d3e3fd) !important;
}

.vsb-menu .multi li:not(.grouped-option)::before {
  color: var(--md-sys-color-outline, #8e9099) !important;
  border-color: var(--md-sys-color-outline, #8e9099) !important;
}

.vsb-menu :not(.multi) li.active::before,
.vsb-menu .multi li.active::after {
  border-bottom-color: var(--md-sys-color-on-primary-container, #d3e3fd) !important;
  border-right-color: var(--md-sys-color-on-primary-container, #d3e3fd) !important;
}

/* Spectrum color picker (Special mode / Custom Colors) */
.sp-replacer {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 8px;
}

.sp-replacer:hover,
.sp-replacer.sp-active {
  border-color: var(--md-sys-color-primary, #a8c7fa) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
}

.sp-container {
  background: var(--md-sys-color-surface-container, #1d2024) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 12px !important;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.52);
}

.sp-picker-container,
.sp-palette-container {
  border-color: var(--md-sys-color-outline-variant, #44474f) !important;
}

.sp-input {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
}

.sp-container button {
  background: var(--md-sys-color-primary-container, #0842a0) !important;
  background-image: none !important;
  color: var(--md-sys-color-on-primary-container, #d3e3fd) !important;
  border: 1px solid var(--md-sys-color-primary, #a8c7fa) !important;
  border-radius: 999px !important;
  text-shadow: none !important;
  padding: 4px 10px !important;
}

.sp-cancel {
  color: var(--md-sys-color-error, #f2b8b5) !important;
}

/* SweetAlert2 dialogs (confirmations, answer check, alerts) */
.swal2-popup {
  background: var(--md-sys-color-surface-container, #1d2024) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 20px !important;
}

.swal2-title {
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
}

.swal2-html-container,
.swal2-content {
  color: var(--md-sys-color-on-surface-variant, #c4c6d0) !important;
}

.swal2-confirm {
  background: var(--md-sys-color-primary-container, #0842a0) !important;
  color: var(--md-sys-color-on-primary-container, #d3e3fd) !important;
  border: 1px solid var(--md-sys-color-primary, #a8c7fa) !important;
  border-radius: 999px !important;
}

.swal2-cancel,
.swal2-deny {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 999px !important;
}

.swal2-input {
  background: var(--md-sys-color-surface-container-high, #282a2f) !important;
  color: var(--md-sys-color-on-surface, #e2e2e9) !important;
  border: 1px solid var(--md-sys-color-outline-variant, #44474f) !important;
  border-radius: 8px !important;
}

/* Tooltips */
.tooltip .tooltiptext {
  background-color: var(--md-sys-color-inverse-surface, #e2e2e9) !important;
  color: var(--md-sys-color-inverse-on-surface, #2e3036) !important;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.42);
}

.tooltip .tooltiptext::after {
  border-color: var(--md-sys-color-inverse-surface, #e2e2e9) transparent transparent transparent !important;
}

/* Status, warnings, timer, and puzzle metadata */
.error_msg,
.warn,
#sourcewarning,
#answerwarning,
#rt5_lb,
#rt5_lb_r {
  color: var(--md-sys-color-error, #f2b8b5) !important;
}

.info,
#stop_watch,
#puzzleinfo,
#contestinfo,
#puzzletitle,
#puzzleauthor,
#puzzlesource,
#solution_check {
  color: var(--md-sys-color-primary, #a8c7fa);
}

/* Scrollbars */
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
