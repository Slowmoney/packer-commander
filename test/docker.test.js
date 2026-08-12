const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    DockerCli,
    DockerRunner,
    ComposeProject,
    parsePsOutput,
    parseImagesOutput,
    ComposeStore,
    createComposeStore,
} = require('../src/task-runner.js');

const cli = () => new DockerCli({ composeFile: '/srv/app/docker-compose.yml' });

function makeTree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-compose-'));
    for (const [rel, content] of Object.entries(files)) {
        const target = path.join(root, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    return root;
}

test('DockerCli строит команды compose с явным -f', () => {
    assert.deepEqual(cli().ps(), {
        command: 'docker',
        args: ['compose', '-f', '/srv/app/docker-compose.yml', 'ps', '--format', 'json'],
        shell: false,
    });

    assert.deepEqual(cli().logs('api', { tail: 50 }).args, [
        'compose',
        '-f',
        '/srv/app/docker-compose.yml',
        'logs',
        '-f',
        '--tail',
        '50',
        'api',
    ]);

    assert.deepEqual(cli().logsAll().args.slice(-4), ['logs', '-f', '--tail', '200']);
});

test('DockerCli различает операции над сервисом и над всем проектом', () => {
    assert.deepEqual(cli().pull('api').args.slice(-2), ['pull', 'api']);
    assert.deepEqual(cli().pullAll().args.slice(-1), ['pull']);
    assert.deepEqual(cli().up('api').args.slice(-3), ['up', '-d', 'api']);
    assert.deepEqual(cli().up('api', { noDeps: true }).args.slice(-4), [
        'up',
        '-d',
        '--no-deps',
        'api',
    ]);
    assert.deepEqual(cli().upAll().args.slice(-2), ['up', '-d']);
    assert.deepEqual(cli().restart('api').args.slice(-2), ['restart', 'api']);
    assert.deepEqual(cli().stop('api').args.slice(-2), ['stop', 'api']);
});

test('DockerCli строит команды образов без compose', () => {
    assert.deepEqual(cli().images('repo/app'), {
        command: 'docker',
        args: ['images', '--digests', '--format', 'json', 'repo/app'],
        shell: false,
    });
    assert.deepEqual(cli().inspectContainerImage('api-1').args, [
        'inspect',
        '--format',
        '{{.Image}}',
        'api-1',
    ]);
    assert.deepEqual(cli().imageDigests('sha256:abc').args, [
        'image',
        'inspect',
        '--format',
        '{{json .RepoDigests}}',
        'sha256:abc',
    ]);
    assert.deepEqual(cli().pullImage('repo/app@sha256:abc').args, ['pull', 'repo/app@sha256:abc']);
    assert.deepEqual(cli().tag('sha256:abc', 'repo/app:api').args, [
        'tag',
        'sha256:abc',
        'repo/app:api',
    ]);
});

test('DockerCli уважает свой путь до docker', () => {
    const custom = new DockerCli({ composeFile: '/c.yml', dockerPath: '/usr/local/bin/docker' });
    assert.equal(custom.ps().command, '/usr/local/bin/docker');
});

test('DockerRunner отдаёт код, stdout и stderr', () => {
    const calls = [];
    const runner = new DockerRunner({
        spawnSyncImpl: (command, args, options) => {
            calls.push({ command, args, options });
            return { status: 0, stdout: 'output', stderr: '' };
        },
    });

    const result = runner.run({ command: 'docker', args: ['ps'], shell: false });

    assert.deepEqual(result, { status: 0, stdout: 'output', stderr: '' });
    assert.equal(calls[0].options.encoding, 'utf8');
    assert.equal(calls[0].options.shell, false);
});

test('DockerRunner превращает отсутствие docker в код 127 и текст ошибки', () => {
    const runner = new DockerRunner({
        spawnSyncImpl: () => ({ error: new Error('spawnSync docker ENOENT') }),
    });

    const result = runner.run({ command: 'docker', args: ['ps'] });

    assert.equal(result.status, 127);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(result.stdout, '');
});

test('ComposeProject находит файл вверх по дереву и читает name', () => {
    const root = makeTree({
        'docker-compose.yml':
            "version: '3.8'\nname: vkboss-light\nservices:\n    api:\n        image: repo/app:api\n",
        '.git/HEAD': 'ref: refs/heads/main\n',
        'apps/api/index.js': '// пусто',
    });

    const project = ComposeProject.find(path.join(root, 'apps', 'api'));

    assert.equal(project.file, path.join(root, 'docker-compose.yml'));
    assert.equal(project.dir, root);
    assert.equal(project.name, 'vkboss-light');
});

test('ComposeProject соблюдает порядок имён файлов', () => {
    const root = makeTree({
        'compose.yaml': 'name: second\n',
        'docker-compose.yml': 'name: first\n',
    });

    assert.equal(ComposeProject.find(root).name, 'first');
});

test('ComposeProject берёт имя папки, когда поля name нет', () => {
    const root = makeTree({ 'docker-compose.yml': 'services:\n    api:\n        image: x\n' });

    assert.equal(ComposeProject.find(root).name, path.basename(root));
});

test('ComposeProject читает только name верхнего уровня', () => {
    const root = makeTree({
        'docker-compose.yml': [
            '# name: commented-out',
            'services:',
            '    api:',
            '        container_name: inner-name',
            '        environment:',
            '            name: env-name',
            'name: "real-name"',
        ].join('\n'),
    });

    assert.equal(ComposeProject.find(root).name, 'real-name');
});

test('ComposeProject возвращает null, когда compose-файла нет', () => {
    const root = makeTree({ 'readme.txt': 'ничего тут нет' });

    assert.equal(ComposeProject.find(root), null);
});

test('parsePsOutput понимает построчный JSON', () => {
    const text = [
        '{"Service":"api","Name":"api-1","State":"running","Status":"Up 3 days","Image":"repo/app:api","ExitCode":0}',
        '{"Service":"worker","Name":"worker-1","State":"exited","Status":"Exited (1) 2 minutes ago","Image":"repo/app:worker","ExitCode":1}',
    ].join('\n');

    assert.deepEqual(parsePsOutput(text), [
        {
            service: 'api',
            name: 'api-1',
            state: 'running',
            status: 'Up 3 days',
            image: 'repo/app:api',
            exitCode: 0,
        },
        {
            service: 'worker',
            name: 'worker-1',
            state: 'exited',
            status: 'Exited (1) 2 minutes ago',
            image: 'repo/app:worker',
            exitCode: 1,
        },
    ]);
});

test('parsePsOutput принимает и массив, и нижний регистр полей', () => {
    const asArray =
        '[{"service":"api","name":"api-1","state":"running","status":"Up","image":"i"}]';
    assert.deepEqual(parsePsOutput(asArray), [
        { service: 'api', name: 'api-1', state: 'running', status: 'Up', image: 'i', exitCode: 0 },
    ]);
});

test('parsePsOutput пропускает мусорные строки и пустой вывод', () => {
    const text = ['не json', '{"Service":"api","Name":"api-1","State":"running"}', '{битый'].join(
        '\n'
    );

    const parsed = parsePsOutput(text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].service, 'api');
    assert.deepEqual(parsePsOutput(''), []);
    assert.deepEqual(parsePsOutput(null), []);
});

test('parseImagesOutput собирает образы с digest и отбрасывает без', () => {
    const text = [
        '{"Repository":"repo/app","Tag":"api","Digest":"sha256:aaa","CreatedAt":"2026-08-12 21:04:11 +0300 MSK","Size":"2.1GB","ID":"111"}',
        '{"Repository":"repo/app","Tag":"<none>","Digest":"sha256:bbb","CreatedAt":"2026-08-11 18:22:00 +0300 MSK","Size":"2.1GB","ID":"222"}',
        '{"Repository":"repo/app","Tag":"api","Digest":"<none>","CreatedAt":"2026-08-01 10:00:00 +0300 MSK","Size":"2.0GB","ID":"333"}',
    ].join('\n');

    const parsed = parseImagesOutput(text);

    assert.deepEqual(
        parsed.map((image) => image.digest),
        ['sha256:aaa', 'sha256:bbb']
    );
    assert.equal(parsed[0].tag, 'api');
    assert.equal(parsed[1].tag, null, 'тег <none> — это отсутствие тега');
    assert.equal(parsed[0].id, '111');
    assert.equal(parsed[0].createdAt instanceof Date, true);
});

function storeFixture(psOutput, { status = 0 } = {}) {
    const project = new ComposeProject({
        file: '/srv/app/docker-compose.yml',
        dir: '/srv/app',
        name: 'vkboss-light',
    });
    const store = new ComposeStore({
        project,
        cli: new DockerCli({ composeFile: project.file }),
        runner: { run: () => ({ status, stdout: psOutput, stderr: 'docker: not found' }) },
    });
    return { store, project };
}

test('ComposeStore читает ps и считает поднятые', async () => {
    const { store } = storeFixture(
        [
            '{"Service":"api","Name":"api-1","State":"running","Status":"Up 3 days","Image":"repo/app:api"}',
            '{"Service":"worker","Name":"worker-1","State":"exited","Status":"Exited (1)","Image":"repo/app:worker","ExitCode":1}',
        ].join('\n')
    );
    let changes = 0;
    store.on('changed', () => {
        changes += 1;
    });

    await store.refresh();

    assert.equal(store.status, 'ready');
    assert.deepEqual(
        store.containers().map((container) => container.service),
        ['api', 'worker']
    );
    assert.deepEqual(store.counters(), { up: 1, total: 2 });
    assert.ok(changes >= 2, 'changed эмитится на начало и конец загрузки');
});

test('ComposeStore считает пустой вывод нормальным состоянием', async () => {
    const { store } = storeFixture('');

    await store.refresh();

    assert.equal(store.status, 'ready');
    assert.deepEqual(store.containers(), []);
    assert.deepEqual(store.counters(), { up: 0, total: 0 });
});

test('ComposeStore объясняет ненулевой код docker', async () => {
    const { store } = storeFixture('', { status: 127 });

    await store.refresh();

    assert.equal(store.status, 'error');
    assert.match(store.reason, /not found/);
});

test('ComposeStore помнит локально переопределённые сервисы', () => {
    const { store } = storeFixture('');

    assert.equal(store.isPinned('api'), false);
    store.pin('api');
    assert.equal(store.isPinned('api'), true);
    store.unpin('api');
    assert.equal(store.isPinned('api'), false);
});

test('createComposeStore выключается без compose-файла и включается с ним', () => {
    const withoutCompose = createComposeStore({
        startDir: '/nowhere',
        fsImpl: { existsSync: () => false, readFileSync: () => '' },
    });
    assert.equal(withoutCompose.isEnabled(), false);
    assert.match(withoutCompose.reason, /compose/i);

    const withCompose = createComposeStore({
        startDir: '/srv/app',
        fsImpl: {
            existsSync: (target) => String(target).endsWith('docker-compose.yml'),
            readFileSync: () => 'name: demo\n',
        },
        spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(withCompose.isEnabled(), true);
    assert.equal(withCompose.project.name, 'demo');
});
