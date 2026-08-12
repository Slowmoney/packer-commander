const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
    WorkspaceIndex,
    NpmCommand,
    AnsiTags,
    LogBuffer,
    Task,
    TaskManager,
    SidePanelModel,
    NavigationStack,
    SearchState,
    stripTags,
    bufferToText,
    copyToClipboard,
    assertTerminal,
    GitLabClient,
    PipelineStore,
    parseGitLabRemote,
    createPipelineStore,
} = require('../src/task-runner.js');

function makeRepo(tree) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runner-'));
    for (const [rel, pkg] of Object.entries(tree)) {
        const dir = path.join(root, rel);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    }
    return root;
}

function fakeChild(pid = 4242) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = [];
    child.kill = (signal) => {
        child.killed.push(signal);
        return true;
    };
    return child;
}

function makeTask({ child = null, ...options } = {}) {
    const task = new Task({
        id: 'id1',
        spec: new NpmCommand({ command: 'build', workspace: 'apps/api' }),
        now: () => 1000,
        ...options,
    });
    const attached = child ?? fakeChild();
    task.attach(attached);
    return { task, child: attached };
}

function makeManager(children = [], extra = {}) {
    const queue = [...children];
    const spawned = [];
    let counter = 0;
    const manager = new TaskManager({
        repoRoot: '/repo',
        spawnImpl: (command, args, options) => {
            spawned.push({ command, args, options });
            return queue.shift() ?? fakeChild(1000 + spawned.length);
        },
        spawnSyncImpl: () => ({ status: 3 }),
        idFactory: () => {
            counter += 1;
            return `id${counter}`;
        },
        ...extra,
    });
    return { manager, spawned };
}

function modelFixture() {
    const root = makeRepo({
        'apps/api': { name: '@ssmm/api', scripts: { build: 'tsc', serve: 'node .' } },
    });
    const index = new WorkspaceIndex({ repoRoot: root });
    index.refresh();
    const child = fakeChild(11);
    const { manager } = makeManager([child]);
    const task = manager.start({ command: 'build', workspace: 'apps/api' });
    const model = new SidePanelModel({ index, manager });
    model.rebuild();
    return { model, manager, task, child };
}

test('WorkspaceIndex собирает пакеты со скриптами из apps и libs', () => {
    const root = makeRepo({
        'apps/api': { name: '@ssmm/api', scripts: { build: 'tsc', serve: 'node .' } },
        'libs/core': { name: '@ssmm/core', scripts: { build: 'tsc' } },
        'apps/empty': { name: '@ssmm/empty', scripts: {} },
        'apps/api/node_modules/junk': { name: 'junk', scripts: { build: 'nope' } },
        'other/skipped': { name: 'skipped', scripts: { build: 'nope' } },
    });

    const index = new WorkspaceIndex({ repoRoot: root });
    index.refresh();

    assert.deepEqual(
        index.packages().map((pkg) => pkg.rel),
        ['apps/api', 'libs/core']
    );
    assert.deepEqual(index.commands(), ['build', 'serve']);
    assert.deepEqual(
        index.packagesWithCommand('serve').map((pkg) => pkg.name),
        ['@ssmm/api']
    );
});

test('WorkspaceIndex ставит недавно использованные команды первыми', () => {
    const root = makeRepo({
        'apps/api': {
            name: '@ssmm/api',
            scripts: { build: 'tsc', serve: 'node .', test: 'node --test' },
        },
    });
    let clock = 1000;
    const index = new WorkspaceIndex({ repoRoot: root, now: () => clock });
    index.refresh();

    index.markCommandUsed('test');
    clock += 10;
    index.markCommandUsed('serve');

    assert.deepEqual(index.commands(), ['serve', 'test', 'build']);
});

test('WorkspaceIndex не падает на битом package.json и на отсутствующих корнях', () => {
    const root = makeRepo({ 'apps/api': { name: '@ssmm/api', scripts: { build: 'tsc' } } });
    fs.writeFileSync(path.join(root, 'apps', 'api', 'package.json'), '{ broken');
    const index = new WorkspaceIndex({ repoRoot: root, roots: ['apps', 'libs', 'nope'] });
    index.refresh();

    assert.deepEqual(index.packages(), []);
    assert.deepEqual(index.commands(), []);
});

test('NpmCommand собирает аргументы npm для обоих режимов', () => {
    const plain = new NpmCommand({ command: 'build', workspace: 'apps/api' });
    assert.deepEqual(plain.args(), ['run', 'build', '--workspace', 'apps/api']);

    const watch = new NpmCommand({ command: 'serve', workspace: 'apps/api', runMode: 'watch' });
    assert.deepEqual(watch.args(), ['run', 'serve', '--workspace', 'apps/api', '--', '--watch']);
});

test('NpmCommand предпочитает npm_execpath и запускает его нашим node', () => {
    const target = new NpmCommand({
        command: 'build',
        workspace: 'apps/api',
        nodePath: '/usr/bin/node',
        npmExecPath: '/npm/npm-cli.js',
        exists: () => true,
    }).spawnTarget();

    assert.deepEqual(target, {
        command: '/usr/bin/node',
        args: ['/npm/npm-cli.js', 'run', 'build', '--workspace', 'apps/api'],
        shell: false,
    });
});

test('NpmCommand находит npm, поставляемый с Node, когда npm_execpath пуст', () => {
    const nodePath = path.join('C:', 'Program Files', 'nodejs', 'node.exe');
    const bundled = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const target = new NpmCommand({
        command: 'serve',
        workspace: 'apps/api',
        platform: 'win32',
        nodePath,
        npmExecPath: '',
        exists: (candidate) => candidate === bundled,
    }).spawnTarget();

    // Так обходится запрет Node на спавн .cmd без shell (EINVAL с 20.12).
    assert.deepEqual(target, {
        command: nodePath,
        args: [bundled, 'run', 'serve', '--workspace', 'apps/api'],
        shell: false,
    });
});

test('NpmCommand в последнюю очередь зовёт npm.cmd и только через shell', () => {
    const onWindows = new NpmCommand({
        command: 'build',
        workspace: 'apps/api',
        platform: 'win32',
        npmExecPath: '',
        exists: () => false,
    }).spawnTarget();
    assert.equal(onWindows.command, 'npm.cmd');
    assert.equal(onWindows.shell, true, 'без shell Node вернёт EINVAL');

    const onLinux = new NpmCommand({
        command: 'build',
        workspace: 'apps/api',
        platform: 'linux',
        npmExecPath: '/npm/gone.js',
        exists: () => false,
    }).spawnTarget();
    assert.equal(onLinux.command, 'npm');
    assert.equal(onLinux.shell, false);
});

test('NpmCommand отдаёт подпись для заголовков', () => {
    assert.equal(
        new NpmCommand({ command: 'serve', workspace: 'apps/api', runMode: 'watch' }).label(),
        'apps/api :: serve --watch'
    );
    assert.equal(
        new NpmCommand({ command: 'build', workspace: 'libs/core' }).label(),
        'libs/core :: build'
    );
});

test('AnsiTags переводит цвета в теги blessed и вырезает остальное', () => {
    assert.equal(AnsiTags.convert('\x1b[31merror\x1b[0m done'), '{red-fg}error{/} done');
    assert.equal(AnsiTags.convert('\x1b[1mbold\x1b[39m'), '{bold}bold{/}');
    assert.equal(AnsiTags.convert('a\x1b[2Kb\x1b[1;5Hc'), 'abc');
});

test('AnsiTags экранирует скобки из вывода, но не свои теги', () => {
    assert.equal(AnsiTags.convert('src/app.ts(4,1): {ok}'), 'src/app.ts(4,1): {open}ok{close}');
    assert.equal(AnsiTags.convert('\x1b[31m{bad}\x1b[0m'), '{red-fg}{open}bad{close}{/}');
});

test('LogBuffer разбирает строки, CRLF и перезапись через \\r', () => {
    const buffer = new LogBuffer({ now: () => new Date(0) });
    buffer.append('first\r\nsecond\n', 'stdout');
    assert.deepEqual(
        buffer.lines().map((line) => line.text),
        ['first', 'second']
    );

    buffer.append('50%\r75%\r100%\n', 'stdout');
    assert.deepEqual(
        buffer.lines().map((line) => line.text),
        ['first', 'second', '100%']
    );
});

test('LogBuffer склеивает неполный хвост со следующим чанком', () => {
    const buffer = new LogBuffer();
    assert.deepEqual(buffer.append('par', 'stdout'), []);
    assert.deepEqual(
        buffer.append('tial\n', 'stdout').map((line) => line.text),
        ['partial']
    );

    buffer.append('no newline', 'stderr');
    assert.equal(buffer.size, 1);
    assert.deepEqual(
        buffer.flush().map((line) => line.text),
        ['no newline']
    );
    assert.equal(buffer.lines()[1].stream, 'stderr');
});

test('LogBuffer держит лимит, выбрасывая старые строки', () => {
    const buffer = new LogBuffer({ limit: 3 });
    buffer.append('a\nb\nc\nd\ne\n', 'stdout');
    assert.deepEqual(
        buffer.lines().map((line) => line.text),
        ['c', 'd', 'e']
    );
    assert.equal(buffer.size, 3);
});

test('LogBuffer ищет по всему буферу без учёта регистра', () => {
    const buffer = new LogBuffer();
    buffer.append('all good\nFound 1 ERROR\nbuild failed: error\n', 'stdout');
    assert.deepEqual(buffer.search('error'), [1, 2]);
    assert.deepEqual(buffer.search('nothing'), []);
    assert.deepEqual(buffer.search(''), []);
});

test('Task переходит в finished при нулевом коде выхода', () => {
    const { task, child } = makeTask();
    assert.equal(task.status, 'running');
    assert.equal(task.pid, 4242);

    const seen = [];
    task.on('status', (status) => seen.push(status));
    child.emit('close', 0, null);

    assert.equal(task.status, 'finished');
    assert.equal(task.exitCode, 0);
    assert.deepEqual(seen, ['finished']);
});

test('Task переходит в failed при ненулевом коде и при ошибке спавна', () => {
    const { task: failedByCode, child } = makeTask();
    child.emit('close', 1, null);
    assert.equal(failedByCode.status, 'failed');
    assert.equal(failedByCode.exitCode, 1);

    const { task: failedBySpawn, child: broken } = makeTask();
    broken.emit('error', new Error('npm not found'));
    assert.equal(failedBySpawn.status, 'failed');
    assert.match(failedBySpawn.log.lines()[0].text, /npm not found/);
});

test('Task после stop остаётся stopped, close его не перебивает', () => {
    const killed = [];
    const { task, child } = makeTask({
        platform: 'linux',
        killImpl: (pid, signal) => killed.push({ pid, signal }),
    });
    task.stop();
    assert.deepEqual(killed, [{ pid: -4242, signal: 'SIGTERM' }]);
    assert.equal(task.status, 'stopped');

    child.emit('close', 1, 'SIGTERM');
    assert.equal(task.status, 'stopped');
    assert.equal(task.exitCode, 1);
});

test('Task на POSIX бьёт по группе процессов, а не только по npm', () => {
    const killed = [];
    const scheduled = [];
    const { task } = makeTask({
        platform: 'linux',
        killImpl: (pid, signal) => killed.push({ pid, signal }),
        setTimeoutImpl: (fn, ms) => {
            scheduled.push({ fn, ms });
            return scheduled.length;
        },
        clearTimeoutImpl: () => {},
    });

    task.stop();
    // Отрицательный pid — вся группа: npm вместе с node/nest, который держит порт.
    assert.deepEqual(killed, [{ pid: -4242, signal: 'SIGTERM' }]);

    scheduled[0].fn();
    assert.deepEqual(killed[1], { pid: -4242, signal: 'SIGKILL' });
});

test('Task на POSIX откатывается на одиночный pid, если группы нет', () => {
    const killed = [];
    const { task } = makeTask({
        platform: 'linux',
        killImpl: (pid, signal) => {
            if (pid < 0) {
                throw new Error('ESRCH');
            }
            killed.push({ pid, signal });
        },
    });

    task.stop();

    assert.deepEqual(killed, [{ pid: 4242, signal: 'SIGTERM' }]);
});

test('Task на Windows снимает дерево через taskkill /T', () => {
    const calls = [];
    const scheduled = [];
    const { task } = makeTask({
        platform: 'win32',
        spawnSyncImpl: (command, args) => {
            calls.push({ command, args });
            return { status: 0 };
        },
        setTimeoutImpl: (fn) => {
            scheduled.push(fn);
            return scheduled.length;
        },
        clearTimeoutImpl: () => {},
    });

    task.stop();
    assert.deepEqual(calls, [{ command: 'taskkill', args: ['/PID', '4242', '/T'] }]);

    scheduled[0]();
    assert.deepEqual(calls[1], { command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });
});

test('TaskManager делает процесс лидером группы на POSIX и не делает на Windows', () => {
    const { manager: posix, spawned: posixSpawned } = makeManager([], { platform: 'linux' });
    posix.start({ command: 'serve', workspace: 'apps/api' });
    assert.equal(posixSpawned[0].options.detached, true);

    const { manager: windows, spawned: windowsSpawned } = makeManager([], { platform: 'win32' });
    windows.start({ command: 'serve', workspace: 'apps/api' });
    assert.equal(windowsSpawned[0].options.detached, false);
});

test('Task планирует добивание через 5 секунд', () => {
    const scheduled = [];
    const { task } = makeTask({
        platform: 'linux',
        killImpl: () => {},
        setTimeoutImpl: (fn, ms) => {
            scheduled.push({ fn, ms });
            return scheduled.length;
        },
        clearTimeoutImpl: () => {},
    });

    task.stop();

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 5000);
});

test('Task не выходит из терминального статуса и не шлёт лишних событий', () => {
    const { task, child } = makeTask();
    child.emit('close', 0, null);
    const seen = [];
    task.on('status', (status) => seen.push(status));

    task.stop();
    child.emit('close', 1, null);

    assert.equal(task.status, 'finished');
    assert.deepEqual(seen, []);
});

test('Task пишет вывод в лог и эмитит lines', () => {
    const { task, child } = makeTask();
    const batches = [];
    task.on('lines', (lines) => batches.push(lines));

    child.stdout.emit('data', 'building\n');
    child.stderr.emit('data', 'oops\n');

    assert.deepEqual(
        task.log.lines().map((line) => [line.stream, line.text]),
        [
            ['stdout', 'building'],
            ['stderr', 'oops'],
        ]
    );
    assert.equal(batches.length, 2);
    assert.equal(batches[1][0].text, 'oops');
});

test('Task считает время работы в mm:ss', () => {
    const { task, child } = makeTask({ now: () => 0 });
    assert.equal(task.runtime(72_000), '1:12');
    child.emit('close', 0, null);
    task.stoppedAt = 130_000;
    assert.equal(task.runtime(999_000), '2:10');
});

test('TaskManager запускает задачу с правильным spawn и эмитит changed', () => {
    // Платформу фиксируем: detached и shell от неё зависят, иначе тест зелёный на
    // одной ОС и красный на другой. Обе платформы проверяет отдельный тест ниже.
    const { manager, spawned } = makeManager([], { platform: 'linux' });
    let changes = 0;
    manager.on('changed', () => {
        changes += 1;
    });

    const task = manager.start({ command: 'build', workspace: 'apps/api', runMode: 'default' });

    assert.equal(task.id, 'id1');
    assert.equal(task.status, 'running');
    assert.deepEqual(spawned[0].args.slice(-4), ['run', 'build', '--workspace', 'apps/api']);
    assert.equal(spawned[0].options.cwd, '/repo');
    assert.deepEqual(spawned[0].options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(changes, 1);
});

test('TaskManager отдаёт задачи новыми первыми и находит по id', () => {
    const { manager } = makeManager();
    manager.start({ command: 'build', workspace: 'apps/api' });
    manager.start({ command: 'serve', workspace: 'libs/core' });

    assert.deepEqual(
        manager.tasks().map((task) => task.id),
        ['id2', 'id1']
    );
    assert.equal(manager.get('id1').command, 'build');
    assert.equal(manager.get('nope'), null);
});

test('TaskManager считает counters по статусам', () => {
    const childA = fakeChild(1);
    const childB = fakeChild(2);
    const childC = fakeChild(3);
    const { manager } = makeManager([childA, childB, childC]);
    manager.start({ command: 'build', workspace: 'apps/a' });
    manager.start({ command: 'build', workspace: 'apps/b' });
    manager.start({ command: 'build', workspace: 'apps/c' });

    childA.emit('close', 0, null);
    childB.emit('close', 1, null);

    assert.deepEqual(manager.counters(), { running: 1, done: 1, failed: 1 });
    assert.equal(manager.hasRunning(), true);
    assert.equal(manager.runningCount(), 1);
});

test('TaskManager эмитит changed при смене статуса задачи', () => {
    const child = fakeChild(7);
    const { manager } = makeManager([child]);
    manager.start({ command: 'build', workspace: 'apps/api' });
    let changes = 0;
    manager.on('changed', () => {
        changes += 1;
    });

    child.emit('close', 0, null);
    assert.equal(changes, 1);
});

test('TaskManager stopAll останавливает только живые', () => {
    const killed = [];
    const childA = fakeChild(1);
    const childB = fakeChild(2);
    const { manager } = makeManager([childA, childB], {
        platform: 'linux',
        taskOptions: {
            platform: 'linux',
            killImpl: (pid, signal) => killed.push({ pid, signal }),
        },
    });
    manager.start({ command: 'build', workspace: 'apps/a' });
    manager.start({ command: 'build', workspace: 'apps/b' });
    childA.emit('close', 0, null);

    manager.stopAll();

    // Живой остался только второй — бьём по его группе и никого больше.
    assert.deepEqual(killed, [{ pid: -2, signal: 'SIGTERM' }]);
});

test('TaskManager forget убирает завершённую и отказывает живой', () => {
    const child = fakeChild(1);
    const { manager } = makeManager([child]);
    manager.start({ command: 'build', workspace: 'apps/api' });

    assert.equal(manager.forget('id1'), false);
    assert.equal(manager.tasks().length, 1);

    child.emit('close', 0, null);
    assert.equal(manager.forget('id1'), true);
    assert.deepEqual(manager.tasks(), []);
    assert.equal(manager.forget('id1'), false);
});

test('TaskManager runForeground возвращает код и не создаёт задачу', () => {
    const { manager } = makeManager();
    const code = manager.runForeground({ command: 'build', workspace: 'apps/api' });
    assert.equal(code, 3);
    assert.deepEqual(manager.tasks(), []);
});

test('SidePanelModel строит три секции, заголовки не выбираются', () => {
    const { model } = modelFixture();
    const rows = model.rows();

    assert.deepEqual(
        rows.filter((row) => row.kind === 'header').map((row) => row.label),
        ['▶ Команды', '● Запущено (1)', '✓ Завершено (0)']
    );
    assert.equal(
        rows.every((row) => (row.kind === 'header') !== row.selectable),
        true
    );
});

test('SidePanelModel перескакивает заголовки при движении курсора', () => {
    const { model } = modelFixture();
    const visited = [];
    for (let step = 0; step < 4; step += 1) {
        visited.push(model.selected().key);
        model.moveCursor(1);
    }

    assert.deepEqual(visited, ['command:build', 'command:serve', 'task:id1', 'task:id1']);
    model.moveCursor(-10);
    assert.equal(model.selected().key, 'command:build');
});

test('SidePanelModel держит курсор на той же задаче после перестройки', () => {
    const { model, child } = modelFixture();
    model.selectKey('task:id1');
    assert.equal(model.selected().key, 'task:id1');

    child.emit('close', 0, null);
    model.rebuild();

    assert.equal(model.selected().key, 'task:id1');
    assert.equal(model.selected().task.status, 'finished');
    assert.deepEqual(
        model
            .rows()
            .filter((row) => row.kind === 'header')
            .map((row) => row.label),
        ['▶ Команды', '● Запущено (0)', '✓ Завершено (1)']
    );
});

test('SidePanelModel после d остаётся на соседней задаче, а не прыгает в начало', () => {
    const root = makeRepo({
        'apps/api': { name: '@ssmm/api', scripts: { build: 'tsc', serve: 'node .' } },
    });
    const index = new WorkspaceIndex({ repoRoot: root });
    index.refresh();
    const children = [fakeChild(1), fakeChild(2), fakeChild(3)];
    const { manager } = makeManager(children);
    for (const workspace of ['apps/a', 'apps/b', 'apps/c']) {
        manager.start({ command: 'build', workspace });
    }
    for (const child of children) {
        child.emit('close', 0, null);
    }
    const model = new SidePanelModel({ index, manager });
    model.rebuild();

    // Завершённые идут новыми первыми: id3, id2, id1. Стоим на среднем и забываем его.
    model.selectKey('task:id2');
    const positionBefore = model.cursorRowIndex();
    manager.forget('id2');
    model.rebuild();

    assert.equal(model.cursorRowIndex(), positionBefore, 'позиция курсора не сдвинулась');
    assert.equal(model.selected().key, 'task:id1', 'курсор на соседней задаче');
});

test('SidePanelModel уходит в начало только когда позади не осталось выбираемых строк', () => {
    const { model, manager, child } = modelFixture();
    // Забываем единственную задачу, стоя на первой команде: секции задач пустеют,
    // и ближайшая выбираемая строка — как раз первая команда.
    model.selectKey('command:build');
    child.emit('close', 0, null);
    manager.forget('id1');
    model.rebuild();

    assert.equal(model.selected().key, 'command:build');
});

test('NavigationStack возвращает предыдущий вид и не уходит ниже корня', () => {
    const stack = new NavigationStack('home');
    assert.equal(stack.depth, 1);
    assert.equal(stack.pop(), null);
    assert.equal(stack.top(), 'home');

    stack.push('help');
    assert.equal(stack.depth, 2);
    assert.equal(stack.top(), 'help');
    assert.equal(stack.pop(), 'help');
    assert.equal(stack.top(), 'home');
    assert.equal(stack.depth, 1);
    assert.equal(stack.pop(), null);
});

test('assertTerminal требует TTY и минимум 80x24', () => {
    assert.throws(
        () => assertTerminal({ stdout: { isTTY: false, columns: 200, rows: 50 } }),
        /интерактивный терминал/
    );
    assert.throws(
        () => assertTerminal({ stdout: { isTTY: true, columns: 60, rows: 50 } }),
        /80×24/
    );
    assert.throws(
        () => assertTerminal({ stdout: { isTTY: true, columns: 120, rows: 10 } }),
        /80×24/
    );
    assert.equal(assertTerminal({ stdout: { isTTY: true, columns: 80, rows: 24 } }), true);
});

test('parseGitLabRemote понимает ssh и https, включая вложенные группы', () => {
    assert.deepEqual(parseGitLabRemote('git@gitlab.com:SSMM_AI/vk-boss-core/vk-boss-core.git'), {
        host: 'gitlab.com',
        projectPath: 'SSMM_AI/vk-boss-core/vk-boss-core',
    });
    assert.deepEqual(parseGitLabRemote('https://gitlab.com/group/sub/app.git'), {
        host: 'gitlab.com',
        projectPath: 'group/sub/app',
    });
    assert.deepEqual(parseGitLabRemote('https://oauth2:token@gitlab.example.ru/g/app'), {
        host: 'gitlab.example.ru',
        projectPath: 'g/app',
    });
    assert.equal(parseGitLabRemote(''), null);
    assert.equal(parseGitLabRemote('/local/path'), null);
});

function fakeFetch(routes) {
    const calls = [];
    const impl = async (url, options = {}) => {
        calls.push({ url, method: options.method ?? 'GET', headers: options.headers });
        const route = Object.keys(routes).find((key) => url.includes(key));
        if (!route) {
            return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        }
        const value = routes[route];
        return {
            ok: true,
            status: 200,
            json: async () => value,
            text: async () => String(value),
        };
    };
    return { impl, calls };
}

test('GitLabClient строит URL с экранированным путём проекта и шлёт токен', async () => {
    const { impl, calls } = fakeFetch({ '/pipelines': [{ id: 1, status: 'success' }] });
    const client = new GitLabClient({
        host: 'gitlab.com',
        projectPath: 'SSMM_AI/vk-boss-core/vk-boss-core',
        token: 'secret',
        fetchImpl: impl,
    });

    const pipelines = await client.pipelines({ ref: 'master', limit: 5 });

    assert.deepEqual(pipelines, [{ id: 1, status: 'success' }]);
    assert.equal(
        calls[0].url,
        'https://gitlab.com/api/v4/projects/SSMM_AI%2Fvk-boss-core%2Fvk-boss-core/pipelines?per_page=5&ref=master'
    );
    assert.equal(calls[0].headers['PRIVATE-TOKEN'], 'secret');
});

test('GitLabClient использует POST для запуска и отмены пайплайна', async () => {
    const { impl, calls } = fakeFetch({ '/pipeline': { id: 42 } });
    const client = new GitLabClient({
        host: 'gitlab.com',
        projectPath: 'g/app',
        token: 't',
        fetchImpl: impl,
    });

    const created = await client.createPipeline('master');
    assert.deepEqual(created, { id: 42 });
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/pipeline\?ref=master$/);

    await client.cancelPipeline(7);
    assert.equal(calls[1].method, 'POST');
    assert.match(calls[1].url, /\/pipelines\/7\/cancel$/);
});

test('GitLabClient бросает понятную ошибку на не-2xx', async () => {
    const client = new GitLabClient({
        host: 'gitlab.com',
        projectPath: 'g/app',
        token: 'bad',
        fetchImpl: async () => ({ ok: false, status: 401 }),
    });
    await assert.rejects(() => client.pipelines({ ref: 'master' }), /GitLab 401/);
});

test('PipelineStore грузит пайплайны, джобы и трассу, эмитит changed', async () => {
    const store = new PipelineStore({
        ref: 'master',
        client: {
            pipelines: async () => [
                { id: 5, status: 'running' },
                { id: 4, status: 'failed' },
            ],
            jobs: async () => [{ id: 50, name: 'build', stage: 'build', status: 'failed' }],
            trace: async () => 'boom\n',
        },
    });
    let changes = 0;
    store.on('changed', () => {
        changes += 1;
    });

    await store.refresh();
    assert.equal(store.status, 'ready');
    assert.deepEqual(
        store.items.map((pipeline) => pipeline.id),
        [5, 4]
    );
    assert.equal(store.hasRunning(), true);

    await store.loadJobs(5);
    assert.equal(store.jobs(5)[0].name, 'build');
    assert.equal(store.jobs(4), null);

    await store.loadTrace(50);
    assert.equal(store.trace(50), 'boom\n');
    assert.ok(changes >= 4, 'changed эмитится на каждую загрузку');
});

test('PipelineStore переживает ошибку сети и остаётся пригодным', async () => {
    const store = new PipelineStore({
        ref: 'master',
        client: {
            pipelines: async () => {
                throw new Error('GitLab 500 /pipelines');
            },
        },
    });

    await store.refresh();

    assert.equal(store.status, 'error');
    assert.match(store.reason, /GitLab 500/);
    assert.deepEqual(store.items, []);
});

test('PipelineStore без токена выключен и объясняет причину', () => {
    const store = createPipelineStore({
        repoRoot: '/repo',
        env: {},
        spawnSyncImpl: (_cmd, args) => ({
            status: 0,
            stdout: args[0] === 'remote' ? 'git@gitlab.com:g/app.git\n' : 'master\n',
        }),
    });

    assert.equal(store.isEnabled(), false);
    assert.equal(store.status, 'disabled');
    assert.equal(store.ref, 'master');
    assert.match(store.reason, /GITLAB_TOKEN/);
});

test('createPipelineStore включается, когда есть remote и токен', () => {
    const store = createPipelineStore({
        repoRoot: '/repo',
        env: { GITLAB_TOKEN: 'secret' },
        spawnSyncImpl: (_cmd, args) => ({
            status: 0,
            stdout: args[0] === 'remote' ? 'git@gitlab.com:g/sub/app.git\n' : 'feature/x\n',
        }),
    });

    assert.equal(store.isEnabled(), true);
    assert.equal(store.ref, 'feature/x');
    assert.equal(store.client.projectPath, 'g/sub/app');
});

test('stripTags возвращает чистый текст и восстанавливает скобки', () => {
    assert.equal(stripTags('{red-fg}error{/} done'), 'error done');
    assert.equal(stripTags('{open}ok{close}'), '{ok}');
    assert.equal(stripTags('{yellow-bg}{black-fg}line{/}'), 'line');
    assert.equal(stripTags('src/app.ts(4,1)'), 'src/app.ts(4,1)');
});

test('stripTags обратен AnsiTags.convert для типичного вывода сборки', () => {
    const raw = '\x1b[31msrc/app.ts(4,1): error TS2345\x1b[0m';
    assert.equal(stripTags(AnsiTags.convert(raw)), 'src/app.ts(4,1): error TS2345');
});

test('bufferToText отдаёт лог без разметки, с таймстемпами по требованию', () => {
    const buffer = new LogBuffer({ now: () => new Date('2026-08-12T10:20:30Z') });
    buffer.append('\x1b[31mboom\x1b[0m\nplain\n', 'stdout');

    assert.equal(bufferToText(buffer), 'boom\nplain');
    assert.equal(bufferToText(buffer, { withTimestamps: true }), '10:20:30 boom\n10:20:30 plain');
    assert.equal(bufferToText(null), '');
});

test('copyToClipboard зовёт системную утилиту по платформе', () => {
    const calls = [];
    const where = copyToClipboard('текст', {
        platform: 'win32',
        spawnSyncImpl: (command, args, options) => {
            calls.push({ command, args, input: options.input });
            return { status: 0 };
        },
        stdout: { write: () => {} },
    });

    assert.equal(where, 'системный буфер');
    assert.deepEqual(calls, [{ command: 'clip', args: [], input: 'текст' }]);
});

test('copyToClipboard падает на OSC 52, когда утилиты нет', () => {
    const written = [];
    const where = copyToClipboard('hi', {
        platform: 'linux',
        spawnSyncImpl: () => ({ error: new Error('ENOENT') }),
        stdout: { write: (text) => written.push(text) },
    });

    assert.equal(where, 'терминал (OSC 52)');
    assert.equal(written.length, 1);
    assert.equal(written[0], `\x1b]52;c;${Buffer.from('hi').toString('base64')}\x07`);
});

test('SearchState.nextMatch циклически ходит по совпадениям', () => {
    assert.equal(SearchState.nextMatch([3, 10, 42], 0, 1), 1);
    assert.equal(SearchState.nextMatch([3, 10, 42], 2, 1), 0);
    assert.equal(SearchState.nextMatch([3, 10, 42], 0, -1), 2);
    assert.equal(SearchState.nextMatch([], 0, 1), 0);
});
