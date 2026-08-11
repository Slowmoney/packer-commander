const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    findProjectRoot,
    workspaceRoots,
    NpmCommand,
    WorkspaceIndex,
} = require('../src/task-runner.js');
const { parseArgs, main } = require('../src/cli.js');

function makeTree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    for (const [rel, content] of Object.entries(files)) {
        const target = path.join(root, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
    }
    return root;
}

test('findProjectRoot предпочитает монорепо с workspaces ближайшему package.json', () => {
    const root = makeTree({
        'package.json': { name: 'monorepo', workspaces: ['apps/*'] },
        '.git/HEAD': 'ref: refs/heads/main\n',
        'apps/api/package.json': { name: 'api', scripts: { build: 'tsc' } },
    });

    assert.equal(findProjectRoot(path.join(root, 'apps', 'api')), root);
    assert.equal(findProjectRoot(root), root);
});

test('findProjectRoot без workspaces останавливается на ближайшем пакете внутри репозитория', () => {
    const root = makeTree({
        '.git/HEAD': 'ref: refs/heads/main\n',
        'tools/thing/package.json': { name: 'thing' },
    });

    assert.equal(findProjectRoot(path.join(root, 'tools', 'thing')), path.join(root, 'tools', 'thing'));
});

test('findProjectRoot возвращает стартовую папку, когда рядом ничего нет', () => {
    const root = makeTree({ 'readme.txt': 'no package.json here' });
    assert.equal(findProjectRoot(root), path.resolve(root));
});

test('workspaceRoots берёт статические головы globs из workspaces', () => {
    const root = makeTree({
        'package.json': { workspaces: ['apps/*', 'libs/**', 'tools/one'] },
    });
    assert.deepEqual(workspaceRoots(root), ['apps', 'libs', 'tools']);
});

test('workspaceRoots понимает объектную форму workspaces', () => {
    const root = makeTree({
        'package.json': { workspaces: { packages: ['services/*'] } },
    });
    assert.deepEqual(workspaceRoots(root), ['services']);
});

test('workspaceRoots падает на привычные имена, а без них — на сам корень', () => {
    const withApps = makeTree({
        'package.json': { name: 'plain' },
        'apps/api/package.json': { name: 'api' },
    });
    assert.deepEqual(workspaceRoots(withApps), ['apps']);

    const bare = makeTree({ 'package.json': { name: 'single', scripts: { build: 'tsc' } } });
    assert.deepEqual(workspaceRoots(bare), ['.']);
});

test('одиночный пакет виден как воркспейс "." и запускается без --workspace', () => {
    const root = makeTree({
        'package.json': { name: 'single', scripts: { build: 'tsc', test: 'node --test' } },
    });
    const index = new WorkspaceIndex({ repoRoot: root, roots: workspaceRoots(root) });
    index.refresh();

    assert.deepEqual(
        index.packages().map((pkg) => pkg.rel),
        ['.']
    );
    assert.deepEqual(index.commands(), ['build', 'test']);

    const command = new NpmCommand({ command: 'build', workspace: '.' });
    assert.equal(command.isRootWorkspace(), true);
    assert.deepEqual(command.args(), ['run', 'build']);
    assert.deepEqual(new NpmCommand({ command: 'build', workspace: '.', runMode: 'watch' }).args(), [
        'run',
        'build',
        '--',
        '--watch',
    ]);
});

test('parseArgs разбирает cwd, roots и флаги', () => {
    assert.deepEqual(parseArgs(['--cwd', '/repo', '--roots', 'apps, libs ,,packages']), {
        cwd: '/repo',
        roots: ['apps', 'libs', 'packages'],
        selfCheck: false,
        help: false,
        version: false,
    });

    const flags = parseArgs(['--self-check', '-h', '-v']);
    assert.equal(flags.selfCheck, true);
    assert.equal(flags.help, true);
    assert.equal(flags.version, true);

    assert.equal(parseArgs(['--nope']).unknown, '--nope');
});

function captureStreams() {
    const out = [];
    const err = [];
    return {
        out,
        err,
        stdout: { write: (text) => out.push(text), isTTY: true, columns: 200, rows: 50 },
        stderr: { write: (text) => err.push(text) },
    };
}

test('main печатает справку и версию, не поднимая TUI', () => {
    const help = captureStreams();
    assert.deepEqual(main(['--help'], help), { code: 0, running: false });
    assert.match(help.out.join(''), /packer-commander/);

    const version = captureStreams();
    assert.deepEqual(main(['--version'], version), { code: 0, running: false });
    assert.match(version.out.join(''), /^\d+\.\d+\.\d+\n$/);
});

test('main ругается на неизвестную опцию кодом 2', () => {
    const streams = captureStreams();
    assert.deepEqual(main(['--wat'], streams), { code: 2, running: false });
    assert.match(streams.err.join(''), /Неизвестная опция: --wat/);
});

test('main --self-check печатает корень, папки и счётчики', () => {
    const root = makeTree({
        'package.json': { name: 'monorepo', workspaces: ['apps/*'] },
        'apps/api/package.json': { name: 'api', scripts: { build: 'tsc' } },
        'apps/web/package.json': { name: 'web', scripts: { build: 'vite build' } },
    });
    const streams = captureStreams();

    assert.deepEqual(main(['--self-check', '--cwd', root], streams), { code: 0, running: false });

    const output = streams.out.join('');
    assert.match(output, /roots=apps/);
    assert.match(output, /packages=2/);
    assert.match(output, /commands=1/);
});

test('main отказывается поднимать TUI без интерактивного терминала', () => {
    const streams = captureStreams();
    streams.stdout.isTTY = false;

    assert.deepEqual(main([], streams), { code: 1, running: false });
    assert.match(streams.err.join(''), /интерактивный терминал/);
});
