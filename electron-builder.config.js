/**
 * electron-builder 打包配置 —— 见 design.md D6。
 *
 * 布局要点：只有 electron/ 进 asar，运行时资产（dist/、dist-server/、node_modules/）
 * 走 extraResources 留在真实文件系统上。这样 server/utils/runtime-paths.js 的
 * findAppRoot 向上查找 package.json 的逻辑原样成立，ripgrep 二进制、node-pty 的
 * spawn-helper、各 .node 文件也都不需要逐项 asarUnpack。
 */

import { Arch } from 'electron-builder';
import { chmodSync, copyFileSync, existsSync, globSync } from 'node:fs';
import path from 'node:path';

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'ai.cloudcli.desktop',
  productName: 'CloudCLI',
  copyright: 'Copyright © CloudCLI contributors',
  directories: {
    output: 'release',
    buildResources: 'public',
  },

  // asar 内只放外壳代码。根 package.json 一并带上，Electron 需要它定位 main 入口。
  files: ['electron/**/*', 'package.json'],
  asar: true,

  // 根 package.json 的 main 必须保持指向 CLI 入口（npx cloudcli 依赖它），
  // 所以只在打包产物内覆写为 Electron 入口，源文件不动。
  extraMetadata: {
    main: 'electron/main.js',
  },

  // 运行时资产映射到 resources/app/，与 electron/main.js 的 resolveBackendEntry 对应。
  // 注意这里不能列 package.json：electron-builder 会把每条 extraResources 的 from 转成
  // asar 的 exclude 规则（platformPackager 的 computeParsedPatterns），于是根 package.json
  // 会被踢出 asar，Electron 启动时直接报 "app.asar is corrupted"。
  // resources/app/package.json 改在 afterPack 里复制。
  extraResources: [
    { from: 'dist', to: 'app/dist' },
    { from: 'dist-server', to: 'app/dist-server' },
    { from: 'node_modules', to: 'app/node_modules' },
    { from: 'shared', to: 'app/shared' },
  ],

  mac: {
    // 只出构建机自身的架构。extraResources 拷的是构建机的 node_modules，而像
    // @vscode/ripgrep 这类按 npm cpu/os 过滤安装可选依赖的包，在 arm64 机器上
    // 压根没有 -darwin-x64 目录，交叉打出来的 x64 产物启动即崩。
    // 需要 Intel 包就在 x64 机器（或 `arch -x86_64 npm ci` 的环境）上重跑打包。
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    category: 'public.app-category.developer-tools',
    icon: 'public/logo-512.png',
    // 本次不做签名与公证（见 proposal「不在本次范围内」）
    identity: null,
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'public/logo-512.png',
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },

  /**
   * scripts/fix-node-pty.js 是 postinstall 钩子，只作用于源码树的 node_modules，
   * 打包产物里不会再跑一次。extraResources 的复制是否保留可执行位无法在不打包的
   * 前提下断言，所以这里直接对产物内的 spawn-helper 再 chmod 一次（幂等）。
   *
   * 同时在这里补上 resources/app/package.json —— server/routes/commands.js 的版本
   * 接口会读它（见上面 extraResources 的说明，它不能走 extraResources）。
   *
   * 最后断言 ripgrep 的架构包在场：它是唯一一个「靠 npm cpu/os 过滤安装、
   * electron-builder 又不会按 arch 重装」的运行时依赖，装错架构时后端会在启动
   * 时直接抛 "Could not find @vscode/ripgrep-<platform>-<arch>"。宁可在这里炸。
   */
  afterPack: async (context) => {
    for (const rel of globSync('**/node-pty/prebuilds/*/spawn-helper', {
      cwd: context.appOutDir,
    })) {
      chmodSync(path.join(context.appOutDir, rel), 0o755);
    }

    const appDir = path.join(context.packager.getResourcesDir(context.appOutDir), 'app');

    copyFileSync(path.join(context.packager.info.projectDir, 'package.json'), path.join(appDir, 'package.json'));

    const rgPkg = `ripgrep-${context.electronPlatformName}-${Arch[context.arch]}`;
    if (!existsSync(path.join(appDir, 'node_modules', '@vscode', rgPkg))) {
      throw new Error(
        `产物缺少 @vscode/${rgPkg}，后端启动会崩。` +
          `当前 node_modules 是为 ${process.platform}-${process.arch} 装的，请在目标架构的机器上打包。`,
      );
    }
  },
};
