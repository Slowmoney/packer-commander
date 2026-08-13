const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
    ProjectIndex,
    MakefileTargets,
    MakeCommand,
    ShellCommand,
    projectRunnables,
    ComposeRegistry,
    TaskManager,
} = require('../src/task-runner.js');

function makeTree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-projects-'));
    for (const [rel, content] of Object.entries(files)) {
        const target = path.join(root, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    return root;
}

function optLike() {
    return makeTree({
        'up-all.sh': 'echo all',
        'clear-docker.sh': 'echo clean',
        'crm-boss/docker-compose.yml': 'name: crm-boss\n',
        'crm-boss/makefile': 'up:\n\tdocker compose up -d\n',
        'crm-boss/check.sh': 'echo check',
        'crm-boss/checkmig.sh': 'echo mig',
        'multichat-bot/compose.yaml': 'name: multichat\n',
        'content-factory/package.json': JSON.stringify({ name: 'cf', scripts: { build: 'tsc' } }),
        'content-factory/Makefile': 'deploy:\n\techo deploy\n',
        'empty-dir/notes.txt': 'ничего запускаемого',
        'node_modules/junk/package.json': JSON.stringify({ name: 'junk', scripts: { a: 'b' } }),
        '.hidden/docker-compose.yml': 'name: hidden\n',
    });
}

function fakeChild(pid = 555) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    return child;
}

test('ProjectIndex находит дочерние проекты каждого сорта и сам корень', () => {
    const root = optLike();
    const index = new ProjectIndex({ root });
    index.refresh();

    assert.deepEqual(
        index.projects().map((project) => project.name),
        [`${path.basename(root)} (корень)`, 'content-factory', 'crm-boss', 'multichat-bot']
    );
    assert.equal(index.hasChildren(), true);
});

test('ProjectIndex описывает содержимое проекта', () => {
    const root = optLike();
    const index = new ProjectIndex({ root });
    index.refresh();

    const crm = index.get(path.join(root, 'crm-boss'));
    assert.equal(path.basename(crm.composeFile), 'docker-compose.yml');
    assert.equal(path.basename(crm.makefile), 'makefile');
    assert.deepEqual(
        crm.scripts.map((script) => path.basename(script)),
        ['check.sh', 'checkmig.sh']
    );
    assert.equal(crm.hasPackageJson, false);

    const factory = index.get(path.join(root, 'content-factory'));
    assert.equal(factory.hasPackageJson, true);
    assert.equal(path.basename(factory.makefile), 'Makefile');
    assert.equal(factory.composeFile, null);

    const rootProject = index.projects()[0];
    assert.equal(rootProject.isRoot, true);
    assert.deepEqual(
        rootProject.scripts.map((script) => path.basename(script)),
        ['clear-docker.sh', 'up-all.sh']
    );
});

test('ProjectIndex пропускает пустые, служебные и скрытые папки', () => {
    const root = optLike();
    const index = new ProjectIndex({ root });
    index.refresh();

    const names = index.projects().map((project) => project.name);
    assert.equal(names.includes('empty-dir'), false);
    assert.equal(names.includes('node_modules'), false);
    assert.equal(names.includes('.hidden'), false);
});

test('ProjectIndex переживает папку без прав на чтение', () => {
    const root = makeTree({ 'ok/check.sh': 'echo ok' });
    const index = new ProjectIndex({
        root,
        fsImpl: {
            readdirSync: (dir, options) => {
                if (String(dir).endsWith('locked')) {
                    throw new Error('EACCES');
                }
                if (String(dir) === root) {
                    return [
                        { name: 'ok', isDirectory: () => true, isFile: () => false },
                        { name: 'locked', isDirectory: () => true, isFile: () => false },
                    ];
                }
                return fs.readdirSync(dir, options);
            },
            existsSync: fs.existsSync,
            readFileSync: fs.readFileSync,
        },
    });
    index.refresh();

    // В корне этого дерева ничего запускаемого нет, поэтому сам корень в список
    // не попадает — остаётся только читаемая дочерняя папка.
    assert.deepEqual(
        index.projects().map((project) => project.name),
        ['ok'],
        'сломанная папка просто пропущена'
    );
});

test('ProjectIndex объясняет, когда дочерних проектов нет', () => {
    const root = makeTree({ 'readme.txt': 'пусто' });
    const index = new ProjectIndex({ root });
    index.refresh();

    assert.equal(index.hasChildren(), false);
    assert.match(index.reason, /не нашлось/i);
});

test('MakefileTargets.parse берёт цели и отсеивает всё остальное', () => {
    const text = [
        '# комментарий',
        'SHELL := /bin/bash',
        'IMAGE ?= repo/app',
        'FLAGS += -x',
        '',
        '.PHONY: up down',
        'up: build',
        '\tdocker compose up -d',
        'down:',
        '\tdocker compose down',
        '%.o: %.c',
        '\tgcc -c $<',
        'deploy:: build',
        '\techo deploy',
        'logs:   ## показать логи',
        '\tdocker compose logs -f',
    ].join('\n');

    assert.deepEqual(MakefileTargets.parse(text), ['up', 'down', 'deploy', 'logs']);
});

test('MakefileTargets.parse не дублирует цели и терпит пустой ввод', () => {
    assert.deepEqual(MakefileTargets.parse('build:\n\ttsc\nbuild:\n\ttsc\n'), ['build']);
    assert.deepEqual(MakefileTargets.parse(''), []);
    assert.deepEqual(MakefileTargets.parse(null), []);
});

test('MakeCommand и ShellCommand дают argv и рабочую папку проекта', () => {
    const make = new MakeCommand({ target: 'up', dir: '/opt/crm-boss', projectName: 'crm-boss' });
    assert.deepEqual(make.spawnTarget(), {
        command: 'make',
        args: ['-C', '/opt/crm-boss', 'up'],
        shell: false,
        cwd: '/opt/crm-boss',
    });
    assert.equal(make.label(), 'make up (crm-boss)');

    const shell = new ShellCommand({
        script: '/opt/crm-boss/check.sh',
        dir: '/opt/crm-boss',
        projectName: 'crm-boss',
    });
    assert.deepEqual(shell.spawnTarget(), {
        command: 'bash',
        args: ['/opt/crm-boss/check.sh'],
        shell: false,
        cwd: '/opt/crm-boss',
    });
    assert.equal(shell.label(), 'sh check.sh (crm-boss)');
});

test('startCommand запускает спеку в её рабочей папке', () => {
    const spawned = [];
    const manager = new TaskManager({
        repoRoot: '/repo',
        platform: 'linux',
        spawnImpl: (command, args, options) => {
            spawned.push({ command, args, cwd: options.cwd });
            return fakeChild();
        },
        idFactory: () => 'p1',
        taskOptions: { platform: 'linux', killImpl: () => {} },
    });

    const task = manager.startCommand(
        new ShellCommand({
            script: '/opt/crm-boss/check.sh',
            dir: '/opt/crm-boss',
            projectName: 'crm-boss',
        })
    );

    assert.equal(task.status, 'running');
    assert.deepEqual(spawned, [
        { command: 'bash', args: ['/opt/crm-boss/check.sh'], cwd: '/opt/crm-boss' },
    ]);
});

test('runTargetForeground отдаёт код и наследует терминал', () => {
    const calls = [];
    const manager = new TaskManager({
        repoRoot: '/repo',
        spawnImpl: () => fakeChild(),
        spawnSyncImpl: (command, args, options) => {
            calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
            return { status: 7 };
        },
        idFactory: () => 'p2',
    });

    const code = manager.runTargetForeground({
        command: 'bash',
        args: ['/opt/up-all.sh'],
        shell: false,
        cwd: '/opt',
    });

    assert.equal(code, 7);
    assert.deepEqual(calls, [
        { command: 'bash', args: ['/opt/up-all.sh'], cwd: '/opt', stdio: 'inherit' },
    ]);
});

test('projectRunnables собирает строки в порядке типов', () => {
    const project = {
        name: 'crm-boss',
        dir: '/opt/crm-boss',
        composeFile: '/opt/crm-boss/docker-compose.yml',
        makefile: '/opt/crm-boss/makefile',
        scripts: ['/opt/crm-boss/check.sh', '/opt/crm-boss/checkmig.sh'],
        hasPackageJson: true,
        isRoot: false,
    };

    const rows = projectRunnables(project, {
        composeStore: { isEnabled: () => true, counters: () => ({ up: 12, total: 14 }) },
        makefileText: 'up:\n\tdocker compose up -d\ndown:\n\tdocker compose down\n',
        packageScripts: ['build'],
    });

    assert.deepEqual(
        rows.map((row) => row.kind),
        ['containers', 'make', 'make', 'sh', 'sh', 'npm']
    );
    assert.match(rows[0].label, /контейнеры 12\/14/);
    assert.equal(rows[1].label, 'make up');
    assert.equal(rows[3].label, 'sh   check.sh');
    assert.equal(rows[5].label, 'npm  build');
    assert.deepEqual(
        rows.map((row) => row.key),
        [
            'containers',
            'make:up',
            'make:down',
            'sh:/opt/crm-boss/check.sh',
            'sh:/opt/crm-boss/checkmig.sh',
            'npm:build',
        ]
    );
});

test('projectRunnables не показывает контейнеры без compose-файла и npm без скриптов', () => {
    const project = {
        name: 'plain',
        dir: '/opt/plain',
        composeFile: null,
        makefile: null,
        scripts: ['/opt/plain/run.sh'],
        hasPackageJson: false,
        isRoot: false,
    };

    const rows = projectRunnables(project, {});

    assert.deepEqual(
        rows.map((row) => row.kind),
        ['sh']
    );
});

test('ComposeRegistry создаёт хранилище лениво и отдаёт тот же экземпляр', () => {
    let runs = 0;
    const registry = new ComposeRegistry({
        spawnSyncImpl: () => {
            runs += 1;
            return { status: 0, stdout: '', stderr: '' };
        },
    });
    const project = {
        name: 'crm-boss',
        dir: '/opt/crm-boss',
        composeFile: '/opt/crm-boss/docker-compose.yml',
    };

    assert.equal(registry.known().length, 0, 'до захода ничего не создано');
    const first = registry.forProject(project);
    const second = registry.forProject(project);

    assert.equal(first, second, 'тот же экземпляр');
    assert.equal(registry.known().length, 1);
    assert.equal(runs, 0, 'создание ничего не опрашивает');
    assert.equal(first.project.name, 'crm-boss');
    assert.equal(first.cli.ps().args.includes('/opt/crm-boss/docker-compose.yml'), true);
});

test('ComposeRegistry не создаёт хранилище проекту без compose', () => {
    const registry = new ComposeRegistry({});
    assert.equal(
        registry.forProject({ name: 'plain', dir: '/opt/plain', composeFile: null }),
        null
    );
});

test('ComposeRegistry пробрасывает changed от своих хранилищ', async () => {
    const registry = new ComposeRegistry({
        spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    let changes = 0;
    registry.on('changed', () => {
        changes += 1;
    });

    const store = registry.forProject({
        name: 'crm-boss',
        dir: '/opt/crm-boss',
        composeFile: '/opt/crm-boss/docker-compose.yml',
    });
    await store.refresh();

    assert.ok(changes >= 2, 'события хранилища видны наружу');
});
