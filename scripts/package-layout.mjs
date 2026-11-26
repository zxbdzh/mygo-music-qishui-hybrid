// Runtime contains portable plugin code and corresponding native source.
// Development-only Node adapters and executable tests stay in validation ZIPs.
import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'

const developmentHelpers = ['helper/worker.mjs', 'helper/resource.cjs', 'helper/native.mjs', 'helper/windows-native.mjs', 'helper/playback.mjs', 'helper/audio-server.mjs', 'helper/catalog.mjs', 'helper/runtime.mjs']
export const runtimeSource = [
  'plugin.json', 'index.js', 'package.json', 'package-lock.json', 'README.md', 'NOTICE.md', 'PLAYBACK-HISTORY.md', 'LICENSE', 'src',
  'helper/catalog-core.mjs', 'helper/protocol.mjs', 'helper/client-profile.mjs', 'helper/json-body.mjs',
  'helper/avatar.mjs', 'helper/comments.mjs', 'helper/membership.mjs', 'helper/library-actions.mjs', 'helper/lyrics.mjs', 'helper/collections.mjs',
  'helper/discovery.mjs', 'helper/history.mjs', 'helper/scene-pages.mjs', 'helper/home-page.mjs', 'helper/exploration.mjs', 'helper/external-source.mjs',
  'helper/m4a.mjs',
  'scripts/build.mjs', 'scripts/package.mjs', 'scripts/package-layout.mjs', 'scripts/build-native.mjs',
  'scripts/runtime-assets.mjs', 'scripts/prepare-windows.mjs', 'scripts/prepare-darwin.mjs',
  'native/worker', 'native/signer', 'native/login',
  'native/windows-runner/main_windows.go', 'native/windows-runner/go.mod', 'native/windows-runner/go.sum', 'native/windows-runner/README',
]
export const validationSource = [
  'VALIDATION.md', 'RELEASE.md', 'test', 'scripts/release.mjs', 'scripts/preflight.mjs', 'scripts/host-ui-fixture.mjs', 'scripts/prepare-node.mjs',
  'scripts/verify-windows.mjs', 'scripts/verify-windows.cmd', 'scripts/build-audio-fixtures.mjs', 'scripts/build-m4a-fixture.mjs',
  'scripts/build-ffmpeg.mjs', 'scripts/ffmpeg-config.mjs',
  'helper/ffmpeg-args.mjs', 'helper/m4a-gapless.mjs',
  'native/windows-runner/tests', 'native/worker', 'native/signer', 'native/login', ...developmentHelpers,
]
export function checkPackageLayout(files, { validation = false } = {}) {
  for (const name of files) {
    if (name.startsWith('assets/')) throw new Error('Package must not contain bundled artwork: ' + name)
    if (/(?:^|\/)(?:node(?:\.exe)?|node-(?:darwin|windows|win32)-[^/]+)$/.test(name) || name === 'bin/NODE-BUILD.json') throw new Error('Package must not contain a Node runtime: ' + name)
    if (/(?:^|\/)(?:ffmpeg(?:\.exe)?|FFMPEG-(?:LICENSE|README\.txt|BUILD\.json|SOURCE\.tar\.xz)|MINGW-LICENSE|ZIG-LICENSE|WINDOWS-CRT-SOURCE\.tar\.xz|audio-convert(?:\.exe)?)$/i.test(name)) throw new Error('Package must not contain a bundled FFmpeg or converter asset: ' + name)
    if (!validation && (
      /\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/i.test(name) || name.startsWith('test/') ||
      /(?:^|\/)tests?(?:\/|\.)/.test(name) || /_test\.go$/.test(name) || /\.test\.(?:cpp|mjs)$/.test(name) ||
      name.startsWith('native/worker/testdata/') || name === 'native/signer/validate.mjs' ||
      /\.test(?:\.exe)?$/i.test(name) || developmentHelpers.includes(name) ||
      /^scripts\/(?:verify-windows\.(?:cmd|mjs)|host-ui-fixture\.mjs|build-audio-fixtures\.mjs|prepare-node\.mjs|preflight\.mjs|release\.mjs)$/.test(name)
    )) throw new Error('Runtime package contains an image or validation-only file: ' + name)
  }
}
export async function copyPackageSource(root, destination, { validation = false } = {}) {
  for (const name of validation ? validationSource : runtimeSource) {
    const target = path.join(destination, name)
    await mkdir(path.dirname(target), { recursive: true })
    // Windows 的 cp filter 收到反斜杠路径；统一成 / 再按相对的运行时规则排除，
    // 否则 testdata、tests 和 signer 验证脚本会漏进运行时包。
    const base = path.join(root, name)
    const excluded = source => {
      const relative = path.relative(root, source).split(path.sep).join('/')
      return /_test\.go$/.test(relative) || /\.test\.(?:cpp|mjs)$/.test(relative) ||
        /(?:^|\/)(?:tests?|testdata)(?:\/|$)/.test(relative) ||
        /(?:^|\/)native\/signer\/validate\.mjs$/.test(relative)
    }
    await cp(base, target, { recursive: true, filter: source => validation || !excluded(source) })
  }
}
