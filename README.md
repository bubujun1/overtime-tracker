# 记加班 (overtime-tracker)

飞牛 NAS（fnOS）上的加班记录与费用核算工具，原生 `.fpk` 应用。

## 功能特性

- 日历视图，加班 / 周末 / 节假日分色标记，点击日期弹出记录框
- 自定义每小时加班费，自动核算加班工资
- 自由添加费用组成条目（餐补、交通、夜班补贴等）
- 实时汇总总时长与总费用
- 数据导入 / 导出备份（覆盖或合并）
- 每天凌晨自动备份，保留最近 3 天
- 卸载保留数据（数据存于 `@apphome`，卸载不删）
- 支持覆盖安装

## 安装

1. 飞牛应用中心 → 手动安装 → 上传 `overtime-tracker.fpk`
2. 或从第三方源一键安装（见下方「更新」）

## 更新（飞牛应用中心一键更新）

本仓库本身就是一个飞牛第三方应用源。把仓库地址添加到飞牛应用中心，即可像官方应用一样**一键安装 / 更新**：

1. 飞牛应用中心 → 设置 / 第三方源 → 添加源
2. 源地址填：`https://github.com/bubujun1/overtime-tracker`
3. 同步后在应用列表找到「记加班」，点击安装 / 更新即可

> 原理：仓库根目录的 `fnpack.json` 是飞牛第三方源索引，`overtime-tracker.fpk` 是安装包。飞牛应用中心读取索引后自动管理版本与升级。你也可以在应用内「设置 → 如何更新」查看当前版本与源地址。

## 本地开发 / 自动发布

- `app/server/server.js`：零依赖 Node 后端（Unix Socket 监听 + REST API + JSON 持久化）
- `app/ui/`：原生前端（CSS/JS 已内联到 `index.html`，规避飞牛反代下外部文件不加载）
- `.github/workflows/release.yml`：打 `v*` tag 后自动 `fnpack build` 并建 GitHub Release 上传 `.fpk`
- 本地打包：下载 fnpack（https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64），执行 `fnpack build`

## 目录结构

```
overtime-tracker/
├── manifest              # fpk 清单（appname/version/依赖）
├── fnpack.json           # 飞牛第三方源索引（一键更新用）
├── ICON.PNG / ICON_256.PNG
├── app/
│   ├── server/server.js  # 后端
│   └── ui/index.html     # 前端（内联 CSS+JS）
├── cmd/main              # 生命周期脚本（含持久化目录 TRIM_PKGHOME/data）
├── config/               # privilege / resource
└── .github/workflows/    # 自动打包发布
```

## 数据位置

- 运行时数据：`/vol1/@apphome/overtime-tracker/data/db.json`
- 每日备份：`/vol1/@apphome/overtime-tracker/data/backups/YYYY-MM-DD.json`（保留 3 天）
- 卸载应用不会删除上述目录
