const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
    DockerCli,
    DockerRunner,
    ComposeProject,
    parsePsOutput,
    parseImagesOutput,
    ComposeStore,
    createComposeStore,
    DockerCommand,
    TaskManager,
    ImageCatalog,
    RegistryLookup,
    GitLabClient,
    imageReferenceForService,
    rollbackTargets,
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

function fakeChild(pid = 4242) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    return child;
}

function sequenceManager(children) {
    const spawnedArgs = [];
    const manager = new TaskManager({
        repoRoot: '/repo',
        platform: 'linux',
        spawnImpl: (command, args) => {
            spawnedArgs.push(args.join(' '));
            return children[spawnedArgs.length - 1] ?? fakeChild(99);
        },
        idFactory: () => `seq${spawnedArgs.length + 1}`,
        taskOptions: { platform: 'linux', killImpl: () => {} },
    });
    return { manager, spawnedArgs };
}

test('startSequence выполняет шаги по очереди и складывает вывод в один лог', () => {
    const children = [fakeChild(11), fakeChild(12)];
    const { manager, spawnedArgs } = sequenceManager(children);

    const task = manager.startSequence({
        label: 'обновить api',
        targets: [
            { command: 'docker', args: ['compose', 'pull', 'api'], shell: false },
            { command: 'docker', args: ['compose', 'up', '-d', 'api'], shell: false },
        ],
    });

    assert.deepEqual(spawnedArgs, ['compose pull api'], 'второй шаг ещё не начат');
    children[0].stdout.emit('data', 'pulled\n');
    children[0].emit('close', 0, null);

    assert.equal(task.status, 'running', 'задача жива между шагами');
    assert.deepEqual(spawnedArgs, ['compose pull api', 'compose up -d api']);
    children[1].stdout.emit('data', 'started\n');
    children[1].emit('close', 0, null);

    assert.equal(task.status, 'finished');
    const text = task.log
        .lines()
        .map((line) => line.text)
        .join('\n');
    assert.match(text, /pulled/);
    assert.match(text, /started/);
});

test('startSequence прерывает цепочку на ненулевом коде', () => {
    const child = fakeChild(21);
    const { manager, spawnedArgs } = sequenceManager([child]);

    const task = manager.startSequence({
        label: 'обновить api',
        targets: [
            { command: 'docker', args: ['compose', 'pull', 'api'], shell: false },
            { command: 'docker', args: ['compose', 'up', '-d', 'api'], shell: false },
        ],
    });

    child.emit('close', 1, null);

    assert.equal(task.status, 'failed');
    assert.equal(spawnedArgs.length, 1, 'второй шаг не запускался');
    assert.match(
        task.log
            .lines()
            .map((line) => line.text)
            .join('\n'),
        /шаг 1 из 2 завершился с кодом 1/
    );
});

test('startDocker делает задачу из одной команды docker', () => {
    const { manager, spawnedArgs } = sequenceManager([fakeChild(31)]);
    const target = new DockerCli({ composeFile: '/c.yml' }).logs('api');

    const task = manager.startDocker({ label: 'logs api', target, service: 'api' });

    assert.equal(task.spec.label(), 'logs api');
    assert.equal(task.workspace, 'api');
    assert.deepEqual(spawnedArgs, [target.args.join(' ')]);
});

test('DockerCommand выглядит для задачи так же, как NpmCommand', () => {
    const target = new DockerCli({ composeFile: '/c.yml' }).logs('api');
    const spec = new DockerCommand({ label: 'logs api', target, service: 'api' });

    assert.equal(spec.label(), 'logs api');
    assert.deepEqual(spec.spawnTarget(), target);
    assert.deepEqual(spec.args(), target.args);
    assert.equal(spec.workspace, 'api');
    assert.equal(spec.runMode, 'default');
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

function catalogFixture({ registry = null } = {}) {
    const runs = [];
    const runner = {
        run: (target) => {
            const args = target.args.join(' ');
            runs.push(args);
            if (args.startsWith('images')) {
                return {
                    status: 0,
                    stdout: [
                        '{"Repository":"repo/app","Tag":"api","Digest":"sha256:aaa","CreatedAt":"2026-08-12 21:04:11 +0300 MSK","ID":"1"}',
                        '{"Repository":"repo/app","Tag":"<none>","Digest":"sha256:bbb","CreatedAt":"2026-08-11 18:22:00 +0300 MSK","ID":"2"}',
                    ].join('\n'),
                    stderr: '',
                };
            }
            if (args.startsWith('image inspect')) {
                return { status: 0, stdout: '["repo/app@sha256:bbb"]\n', stderr: '' };
            }
            if (args.startsWith('inspect')) {
                return { status: 0, stdout: 'sha256:imageid\n', stderr: '' };
            }
            return { status: 1, stdout: '', stderr: 'неизвестная команда' };
        },
    };
    const catalog = new ImageCatalog({
        cli: new DockerCli({ composeFile: '/c.yml' }),
        runner,
        registry,
    });
    return { catalog, runs };
}

test('ImageCatalog сливает локальные образы и помечает запущенный', async () => {
    const { catalog } = catalogFixture();

    const { items } = await catalog.build({ repo: 'repo/app', tag: 'api', container: 'api-1' });

    assert.deepEqual(
        items.map((item) => item.digest),
        ['sha256:aaa', 'sha256:bbb'],
        'сортировка по дате вниз'
    );
    assert.deepEqual(items[0].sources, ['local']);
    assert.equal(items[0].isCurrent, false);
    assert.equal(items[1].isCurrent, true, 'запущен старый образ');
});

test('ImageCatalog добавляет digest из реестра и не дублирует локальный', async () => {
    const { catalog } = catalogFixture({
        registry: {
            tagDigest: async () => ({ digest: 'sha256:aaa', createdAt: new Date('2026-08-12') }),
        },
    });

    const { items, registryReason } = await catalog.build({
        repo: 'repo/app',
        tag: 'api',
        container: 'api-1',
    });

    assert.equal(registryReason, '');
    const current = items.find((item) => item.digest === 'sha256:aaa');
    assert.deepEqual(current.sources, ['local', 'registry']);
    assert.equal(items.length, 2, 'реестровый digest совпал с локальным — записей всё ещё две');
});

test('ImageCatalog переживает недоступный реестр', async () => {
    const { catalog } = catalogFixture({
        registry: {
            tagDigest: async () => {
                throw new Error('GitLab 403 /registry');
            },
        },
    });

    const { items, registryReason } = await catalog.build({
        repo: 'repo/app',
        tag: 'api',
        container: 'api-1',
    });

    assert.equal(items.length, 2, 'локальные образы на месте');
    assert.match(registryReason, /403/);
});

test('RegistryLookup находит репозиторий реестра по имени и отдаёт digest тега', async () => {
    const calls = [];
    const lookup = new RegistryLookup({
        repo: 'registry.gitlab.com/g/app',
        client: {
            registryRepositories: async () => {
                calls.push('repos');
                return [
                    { id: 3, location: 'registry.gitlab.com/g/other' },
                    { id: 7, location: 'registry.gitlab.com/g/app' },
                ];
            },
            registryTag: async (repositoryId, tagName) => {
                calls.push(`tag:${repositoryId}:${tagName}`);
                return { name: tagName, digest: 'sha256:ccc', created_at: '2026-08-10T09:15:00Z' };
            },
        },
    });

    const first = await lookup.tagDigest('api');
    assert.equal(first.digest, 'sha256:ccc');
    assert.equal(first.createdAt.toISOString(), '2026-08-10T09:15:00.000Z');

    await lookup.tagDigest('api');
    assert.deepEqual(calls, ['repos', 'tag:7:api', 'tag:7:api'], 'список репозиториев кешируется');
});

test('RegistryLookup отдаёт null, когда репозитория нет в реестре', async () => {
    const lookup = new RegistryLookup({
        repo: 'registry.gitlab.com/g/app',
        client: { registryRepositories: async () => [], registryTag: async () => ({}) },
    });

    assert.equal(await lookup.tagDigest('api'), null);
});

test('GitLabClient умеет реестр', async () => {
    const calls = [];
    const client = new GitLabClient({
        host: 'gitlab.com',
        projectPath: 'g/app',
        token: 't',
        fetchImpl: async (url) => {
            calls.push(url);
            return {
                ok: true,
                status: 200,
                json: async () => ({ name: 'api', digest: 'sha256:ccc', created_at: '2026-08-10' }),
                text: async () => '',
            };
        },
    });

    await client.registryRepositories();
    await client.registryTag(7, 'api');

    assert.match(calls[0], /\/registry\/repositories\?tags=true&per_page=100$/);
    assert.match(calls[1], /\/registry\/repositories\/7\/tags\/api$/);
});

test('imageReferenceForService разбирает образ контейнера', () => {
    assert.deepEqual(imageReferenceForService({ image: 'registry.gitlab.com/g/app:api' }), {
        repo: 'registry.gitlab.com/g/app',
        tag: 'api',
    });
    assert.deepEqual(imageReferenceForService({ image: 'nginx' }), {
        repo: 'nginx',
        tag: 'latest',
    });
    assert.equal(imageReferenceForService({ image: '' }), null);
});

test('rollbackTargets пропускает pull для локального образа', () => {
    const dockerCli = new DockerCli({ composeFile: '/c.yml' });
    const withPull = rollbackTargets({
        cli: dockerCli,
        repo: 'repo/app',
        tag: 'api',
        digest: 'sha256:bbb',
        service: 'api',
        alreadyLocal: false,
    });
    assert.deepEqual(
        withPull.map((target) => target.args[0]),
        ['pull', 'tag', 'compose']
    );
    assert.deepEqual(withPull[0].args, ['pull', 'repo/app@sha256:bbb']);
    assert.deepEqual(withPull[1].args, ['tag', 'repo/app@sha256:bbb', 'repo/app:api']);
    assert.deepEqual(withPull[2].args.slice(-4), ['up', '-d', '--no-deps', 'api']);

    const localOnly = rollbackTargets({
        cli: dockerCli,
        repo: 'repo/app',
        tag: 'api',
        digest: 'sha256:bbb',
        service: 'api',
        alreadyLocal: true,
    });
    assert.deepEqual(
        localOnly.map((target) => target.args[0]),
        ['tag', 'compose'],
        'скачивать нечего'
    );
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
