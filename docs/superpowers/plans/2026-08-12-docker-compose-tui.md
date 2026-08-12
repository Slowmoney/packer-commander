# Секция Docker Compose — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в packer-commander секцию docker compose: список контейнеров, живые логи как задача, `pull && up -d` для сервиса и проекта, откат на любой локальный или реестровый образ без правки compose-файла.

**Architecture:** Ядро прирастает классами `ComposeProject`, `DockerCli`, `DockerRunner`, `ComposeStore`, `ImageCatalog` — все без blessed, все внешние вызовы инжектируются. `Task` перестаёт быть завязан на `NpmCommand`: вводится общая «спека команды» (`args()`, `spawnTarget()`, `label()`), рядом с `NpmCommand` встаёт `DockerCommand`. Цепочки (`pull → tag → up -d`) исполняются одной задачей через `TaskManager.startSequence`. UI переиспользует существующие приёмы: пункт слева → список справа → меню действий → подтверждение → задача.

**Tech Stack:** Node 20+ (CommonJS), `blessed@0.1.81`, `node:test` + `node:assert/strict`, docker CLI (внешний, в тестах не вызывается).

**Spec:** `docs/superpowers/specs/2026-08-12-docker-compose-tui-design.md`

## Global Constraints

- **Один файл реализации:** всё в `src/task-runner.js`. Тесты — `test/docker.test.js` (новый) и дополнения в `test/task-runner.test.js`, `test/ui-smoke.test.js`.
- **Новых зависимостей не добавлять.** YAML не парсим библиотекой: из compose-файла нужно только поле `name:` верхнего уровня.
- **Никаких буквенных хоткеев в правой колонке.** Буквы там — фильтр. Все действия — через меню по `Enter`. Нарушение этого правила уже дважды ломало раннер (`w` = watch, действия docker на буквах).
- **Всё, что меняет состояние docker, идёт через `ConfirmView`** с точным списком команд. Читающие вызовы (`ps`, `images`, `inspect`, реестр) — без спроса.
- **Ни один тест не зовёт настоящий docker.** `spawnSync`/`spawn` инжектируются всегда.
- **Без shell:** все команды — массивы argv. Аргументы приходят из compose-файла и реестра.
- CommonJS, отступ 4 пробела, ESC в коде как `\x1b`, управляющих байтов в исходнике быть не должно.
- Коммит после каждой задачи. Версию поднимаем один раз в конце (Task 11), тег пушится — публикацию делает GitHub Actions.

---

### Task 1: `DockerCli` и `DockerRunner`

**Files:**
- Modify: `src/task-runner.js`
- Create: `test/docker.test.js`
- Modify: `package.json` (добавить новый тест-файл в скрипт `test`)

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `DockerCli` — конструктор `({ composeFile, dockerPath = 'docker' })`; методы возвращают `{ command, args, shell: false }`: `ps()`, `logs(service, { tail = 200 })`, `logsAll({ tail = 200 })`, `pull(service)`, `pullAll()`, `up(service, { noDeps = false })`, `upAll()`, `restart(service)`, `stop(service)`, `images(repo)`, `inspectContainerImage(container)`, `imageDigests(imageId)`, `pullImage(reference)`, `tag(source, target)`.
  - `DockerRunner` — конструктор `({ spawnSyncImpl = spawnSync })`; метод `run(target)` → `{ status: number, stdout: string, stderr: string }`. Для читающих команд; долгие идут через задачи.

- [ ] **Step 1: Написать падающий тест**

Создать `test/docker.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { DockerCli, DockerRunner } = require('../src/task-runner.js');

const cli = () => new DockerCli({ composeFile: '/srv/app/docker-compose.yml' });

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

    assert.deepEqual(cli().logsAll().args.slice(-3), ['logs', '-f', '--tail']);
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
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/docker.test.js`
Expected: FAIL — `DockerCli is not a constructor`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавить в `src/task-runner.js` перед `class WorkspaceIndex`:

```js
const DEFAULT_LOG_TAIL = 200;

/** Строит argv для docker. Только строит: исполняют DockerRunner или задачи. */
class DockerCli {
    constructor({ composeFile, dockerPath = 'docker' }) {
        this.composeFile = composeFile;
        this.dockerPath = dockerPath;
    }

    #target(args) {
        return { command: this.dockerPath, args, shell: false };
    }

    #compose(args) {
        return this.#target(['compose', '-f', this.composeFile, ...args]);
    }

    ps() {
        return this.#compose(['ps', '--format', 'json']);
    }

    logs(service, { tail = DEFAULT_LOG_TAIL } = {}) {
        return this.#compose(['logs', '-f', '--tail', String(tail), service]);
    }

    logsAll({ tail = DEFAULT_LOG_TAIL } = {}) {
        return this.#compose(['logs', '-f', '--tail', String(tail)]);
    }

    pull(service) {
        return this.#compose(['pull', service]);
    }

    pullAll() {
        return this.#compose(['pull']);
    }

    up(service, { noDeps = false } = {}) {
        const args = ['up', '-d'];
        if (noDeps) {
            args.push('--no-deps');
        }
        args.push(service);
        return this.#compose(args);
    }

    upAll() {
        return this.#compose(['up', '-d']);
    }

    restart(service) {
        return this.#compose(['restart', service]);
    }

    stop(service) {
        return this.#compose(['stop', service]);
    }

    images(repo) {
        return this.#target(['images', '--digests', '--format', 'json', repo]);
    }

    inspectContainerImage(container) {
        return this.#target(['inspect', '--format', '{{.Image}}', container]);
    }

    imageDigests(imageId) {
        return this.#target(['image', 'inspect', '--format', '{{json .RepoDigests}}', imageId]);
    }

    pullImage(reference) {
        return this.#target(['pull', reference]);
    }

    tag(source, target) {
        return this.#target(['tag', source, target]);
    }
}

/** Синхронный запуск читающих команд docker. Долгие идут через задачи. */
class DockerRunner {
    constructor({ spawnSyncImpl = spawnSync } = {}) {
        this.spawnSyncImpl = spawnSyncImpl;
    }

    run(target) {
        const result = this.spawnSyncImpl(target.command, target.args, {
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
        });
        if (!result || result.error) {
            return { status: 127, stdout: '', stderr: result?.error?.message ?? 'spawn failed' };
        }
        return {
            status: result.status ?? 1,
            stdout: String(result.stdout ?? ''),
            stderr: String(result.stderr ?? ''),
        };
    }
}
```

Добавить `DockerCli` и `DockerRunner` в `module.exports`.

- [ ] **Step 4: Подключить новый тест-файл**

В `package.json` заменить скрипт `test` на:

```json
"test": "node --test test/task-runner.test.js test/cli.test.js test/ui-smoke.test.js test/docker.test.js",
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: PASS, все прежние тесты плюс 6 новых.

- [ ] **Step 6: Коммит**

```bash
git add src/task-runner.js test/docker.test.js package.json
git commit -m "feat(docker): DockerCli и DockerRunner"
```

---

### Task 2: `ComposeProject` — поиск файла и имя проекта

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/docker.test.js`

**Interfaces:**
- Consumes: `readJsonFile` не нужен; используется `fs` напрямую через инжекцию.
- Produces: `ComposeProject` — статический `ComposeProject.find(startDir, { fsImpl = fs })` → `ComposeProject | null`; поля `file` (абсолютный путь), `name`, `dir`. Константа `COMPOSE_FILENAMES = ['docker-compose.yml', 'compose.yaml', 'docker-compose.yaml']`.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/docker.test.js` (и добавить `ComposeProject` в деструктуризацию `require`, плюс `fs`, `os`, `path` в начало файла):

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeTree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-compose-'));
    for (const [rel, content] of Object.entries(files)) {
        const target = path.join(root, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    return root;
}

test('ComposeProject находит файл вверх по дереву и читает name', () => {
    const root = makeTree({
        'docker-compose.yml': "version: '3.8'\nname: vkboss-light\nservices:\n    api:\n        image: repo/app:api\n",
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
    // Отступ, комментарий и ключ внутри сервиса не должны сойти за имя проекта.
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
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/docker.test.js`
Expected: FAIL — `ComposeProject is not defined`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавить в `src/task-runner.js`:

```js
const COMPOSE_FILENAMES = ['docker-compose.yml', 'compose.yaml', 'docker-compose.yaml'];
// Имя проекта — единственное, что нужно из compose-файла, поэтому берём его
// регуляркой по строкам, а не тянем в зависимости парсер YAML. Ключ учитывается
// только без отступа: "name:" внутри сервиса или в environment — не про проект.
const COMPOSE_NAME_LINE = /^name:\s*["']?([^"'#\s]+)/;

class ComposeProject {
    constructor({ file, dir, name }) {
        this.file = file;
        this.dir = dir;
        this.name = name;
    }

    static find(startDir, { fsImpl = fs } = {}) {
        let dir = path.resolve(startDir);
        for (;;) {
            for (const filename of COMPOSE_FILENAMES) {
                const candidate = path.join(dir, filename);
                if (fsImpl.existsSync(candidate)) {
                    return new ComposeProject({
                        file: candidate,
                        dir,
                        name: ComposeProject.readName(candidate, { fsImpl }) ?? path.basename(dir),
                    });
                }
            }
            if (fsImpl.existsSync(path.join(dir, '.git'))) {
                return null;
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                return null;
            }
            dir = parent;
        }
    }

    static readName(file, { fsImpl = fs } = {}) {
        try {
            for (const line of fsImpl.readFileSync(file, 'utf8').split('\n')) {
                const match = line.match(COMPOSE_NAME_LINE);
                if (match) {
                    return match[1];
                }
            }
        } catch {
            return null;
        }
        return null;
    }
}
```

Добавить `ComposeProject` и `COMPOSE_FILENAMES` в `module.exports`.

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 5 новых тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/task-runner.js test/docker.test.js
git commit -m "feat(docker): поиск compose-файла и имени проекта"
```

---

### Task 3: Парсеры вывода `ps` и `images`

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/docker.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `parsePsOutput(text)` → `{ service, name, state, status, image, exitCode }[]`.
  - `parseImagesOutput(text)` → `{ repository, tag, digest, createdAt, size, id }[]`; записи без digest отбрасываются.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/docker.test.js` (и в деструктуризацию `require`):

```js
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
    const asArray = '[{"service":"api","name":"api-1","state":"running","status":"Up","image":"i"}]';
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
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/docker.test.js`
Expected: FAIL — `parsePsOutput is not defined`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавить в `src/task-runner.js`:

```js
/**
 * `docker compose ps --format json` в разных версиях отдаёт то построчный JSON,
 * то массив, а поля пишет то с большой буквы, то с маленькой. Терпим оба вида,
 * битые строки пропускаем.
 */
function parseJsonRecords(text) {
    const source = String(text ?? '').trim();
    if (!source) {
        return [];
    }
    if (source.startsWith('[')) {
        try {
            const parsed = JSON.parse(source);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    const records = [];
    for (const line of source.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            records.push(JSON.parse(trimmed));
        } catch {
            // строка не JSON — пропускаем, остальные всё равно пригодны
        }
    }
    return records;
}

function pickField(record, ...names) {
    for (const name of names) {
        if (record[name] !== undefined) {
            return record[name];
        }
    }
    return undefined;
}

function parsePsOutput(text) {
    return parseJsonRecords(text).map((record) => ({
        service: String(pickField(record, 'Service', 'service') ?? ''),
        name: String(pickField(record, 'Name', 'name') ?? ''),
        state: String(pickField(record, 'State', 'state') ?? ''),
        status: String(pickField(record, 'Status', 'status') ?? ''),
        image: String(pickField(record, 'Image', 'image') ?? ''),
        exitCode: Number(pickField(record, 'ExitCode', 'exitCode') ?? 0),
    }));
}

function parseImagesOutput(text) {
    return parseJsonRecords(text)
        .map((record) => {
            const digest = String(pickField(record, 'Digest', 'digest') ?? '');
            const tag = String(pickField(record, 'Tag', 'tag') ?? '');
            const createdAt = new Date(String(pickField(record, 'CreatedAt', 'createdAt') ?? ''));
            return {
                repository: String(pickField(record, 'Repository', 'repository') ?? ''),
                tag: tag && tag !== '<none>' ? tag : null,
                digest,
                createdAt: Number.isNaN(createdAt.getTime()) ? null : createdAt,
                size: String(pickField(record, 'Size', 'size') ?? ''),
                id: String(pickField(record, 'ID', 'Id', 'id') ?? ''),
            };
        })
        .filter((image) => image.digest && image.digest !== '<none>');
}
```

Добавить `parsePsOutput` и `parseImagesOutput` в `module.exports`.

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 4 новых теста.

- [ ] **Step 5: Коммит**

```bash
git add src/task-runner.js test/docker.test.js
git commit -m "feat(docker): парсеры вывода ps и images"
```

---

### Task 4: `ComposeStore`

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/docker.test.js`

**Interfaces:**
- Consumes: `DockerCli` (Task 1), `DockerRunner` (Task 1), `ComposeProject` (Task 2), `parsePsOutput` (Task 3).
- Produces: `ComposeStore extends EventEmitter` — конструктор `({ project = null, cli = null, runner = null, reason = '' })`; методы `isEnabled()`, `refresh()`, `containers()`, `counters()` → `{ up, total }`, `pin(service)`, `unpin(service)`, `isPinned(service)`, `hasRunning()`; поля `status` (`idle | loading | ready | error | disabled`), `reason`, `items`. Событие `changed`. Плюс `createComposeStore({ startDir, fsImpl, spawnSyncImpl })` → `ComposeStore`.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/docker.test.js`:

```js
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

test('createComposeStore выключается без compose-файла и без docker', () => {
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
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/docker.test.js`
Expected: FAIL — `ComposeStore is not defined`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавить в `src/task-runner.js`:

```js
/** Состояние контейнеров проекта. Только чтение: ничего не пишет и не спрашивает. */
class ComposeStore extends EventEmitter {
    constructor({ project = null, cli = null, runner = null, reason = '' }) {
        super();
        this.project = project;
        this.cli = cli;
        this.runner = runner;
        this.status = project && cli && runner ? 'idle' : 'disabled';
        this.reason = reason;
        this.items = [];
        this.pinned = new Set();
    }

    isEnabled() {
        return this.status !== 'disabled';
    }

    containers() {
        return this.items;
    }

    counters() {
        const up = this.items.filter((container) => container.state === 'running').length;
        return { up, total: this.items.length };
    }

    hasRunning() {
        return this.items.some((container) => container.state === 'running');
    }

    pin(service) {
        this.pinned.add(service);
        this.emit('changed');
    }

    unpin(service) {
        this.pinned.delete(service);
        this.emit('changed');
    }

    isPinned(service) {
        return this.pinned.has(service);
    }

    async refresh() {
        if (!this.isEnabled() || this.status === 'loading') {
            return;
        }
        this.status = 'loading';
        this.emit('changed');
        const result = this.runner.run(this.cli.ps());
        if (result.status !== 0) {
            this.status = 'error';
            this.reason = (result.stderr || 'docker вернул ошибку').trim();
        } else {
            this.items = parsePsOutput(result.stdout);
            this.status = 'ready';
            this.reason = '';
        }
        this.emit('changed');
    }
}

function createComposeStore({ startDir, fsImpl = fs, spawnSyncImpl = spawnSync } = {}) {
    const project = ComposeProject.find(startDir, { fsImpl });
    if (!project) {
        return new ComposeStore({ reason: 'Рядом нет compose-файла.' });
    }
    return new ComposeStore({
        project,
        cli: new DockerCli({ composeFile: project.file }),
        runner: new DockerRunner({ spawnSyncImpl }),
    });
}
```

Добавить `ComposeStore` и `createComposeStore` в `module.exports`.

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 5 новых тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/task-runner.js test/docker.test.js
git commit -m "feat(docker): ComposeStore со состоянием контейнеров"
```

---

### Task 5: Общая спека команды и `TaskManager.startSequence`

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/task-runner.test.js`

**Interfaces:**
- Consumes: `Task`, `TaskManager`, `NpmCommand` (существующие).
- Produces:
  - `Task` принимает `spec` вместо `npmCommand`; геттер `npmCommand` **удаляется**, вместо него `spec`. Геттеры `workspace`, `command`, `runMode` остаются и читают `this.spec`.
  - `CommandSequence` — конструктор `({ label, targets })`; методы `label()`, `spawnTarget()` (первый шаг), `next()` → следующий шаг или `null`, `size`.
  - `TaskManager.startSequence({ label, targets, workspace = null })` → `Task`. Один лог, шаги по очереди, ненулевой код прерывает остаток и оставляет `failed`.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/task-runner.test.js`:

```js
test('startSequence выполняет шаги по очереди и складывает вывод в один лог', () => {
    const children = [fakeChild(11), fakeChild(12)];
    const spawnedArgs = [];
    const manager = new TaskManager({
        repoRoot: '/repo',
        platform: 'linux',
        spawnImpl: (command, args) => {
            spawnedArgs.push(args.join(' '));
            return children[spawnedArgs.length - 1];
        },
        idFactory: () => 'seq1',
        taskOptions: { platform: 'linux', killImpl: () => {} },
    });

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
    const spawnedArgs = [];
    const manager = new TaskManager({
        repoRoot: '/repo',
        platform: 'linux',
        spawnImpl: (command, args) => {
            spawnedArgs.push(args.join(' '));
            return child;
        },
        idFactory: () => 'seq2',
        taskOptions: { platform: 'linux', killImpl: () => {} },
    });

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

test('Task отдаёт подпись через spec, а не через npm', () => {
    const { task } = makeTask();
    assert.equal(task.spec.label(), 'apps/api :: build');
    assert.equal(task.workspace, 'apps/api');
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/task-runner.test.js`
Expected: FAIL — `manager.startSequence is not a function`.

- [ ] **Step 3: Переименовать `npmCommand` в `spec`**

В `src/task-runner.js` заменить во всех местах:

- в конструкторе `Task`: параметр `npmCommand` → `spec`, поле `this.npmCommand = npmCommand` → `this.spec = spec`;
- геттеры `workspace`, `command`, `runMode` читают `this.spec`;
- в `TaskManager.start`: `new Task({ id: this.idFactory(), npmCommand, ... })` → `new Task({ id: this.idFactory(), spec: npmCommand, ... })`;
- в `HomeView.renderLog` и `TaskDetailsView`: `task.npmCommand.label()` → `task.spec.label()`;
- в тестах `test/task-runner.test.js` и `test/ui-smoke.test.js`: `npmCommand:` → `spec:`, `npmCommand.label` → `spec.label`.

Проверить, что не осталось упоминаний:

Run: `npx rg -n "npmCommand" src test`
Expected: ни одного совпадения.

- [ ] **Step 4: Реализовать `CommandSequence` и `startSequence`**

Добавить в `src/task-runner.js` перед `class TaskManager`:

```js
/**
 * Спека из нескольких шагов: pull → up -d, pull → tag → up -d. Для задачи это
 * одна сущность с одним логом; шаги идут по очереди.
 */
class CommandSequence {
    constructor({ label, targets, workspace = null }) {
        this.text = label;
        this.targets = targets;
        this.workspace = workspace;
        this.command = label;
        this.runMode = 'default';
        this.index = 0;
    }

    get size() {
        return this.targets.length;
    }

    label() {
        return this.text;
    }

    spawnTarget() {
        return this.targets[this.index];
    }

    /** Сдвигает шаг вперёд и отдаёт его, либо null, если цепочка кончилась. */
    next() {
        this.index += 1;
        return this.targets[this.index] ?? null;
    }
}
```

Добавить в `TaskManager` метод:

```js
    /**
     * Задача из цепочки команд. Между шагами задача остаётся running, ненулевой
     * код прерывает остаток — в логе видно, на каком шаге всё встало.
     */
    startSequence({ label, targets, workspace = null }) {
        const spec = new CommandSequence({ label, targets, workspace });
        const task = new Task({ id: this.idFactory(), spec, ...this.taskOptions });
        task.on('status', () => this.emit('changed'));
        task.onStepDone = (code) => {
            if (code !== 0) {
                task.noteStepFailure(spec.index + 1, spec.size, code);
                return false;
            }
            const nextTarget = spec.next();
            if (!nextTarget) {
                return false;
            }
            task.attach(this.#spawn(nextTarget));
            return true;
        };
        task.attach(this.#spawn(spec.spawnTarget()));
        this.items.push(task);
        this.emit('changed');
        return task;
    }

    #spawn(target) {
        return this.spawnImpl(target.command, target.args, {
            cwd: this.repoRoot,
            detached: this.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: target.shell === true,
            windowsHide: true,
        });
    }
```

`TaskManager.start` переписать на использование `#spawn(target)`, чтобы опции спавна жили в одном месте.

- [ ] **Step 5: Научить `Task` продолжать цепочку**

В `Task` добавить поле `this.onStepDone = null;` в конструктор и изменить обработчик `close`:

```js
        child.on('close', (code, signal) => {
            this.exitCode = code ?? null;
            this.signal = signal ?? null;
            this.#emitLines(this.log.flush());
            // Цепочка: если есть следующий шаг, задача остаётся running.
            if (this.onStepDone && this.isRunning() && this.onStepDone(code) === true) {
                return;
            }
            this.#transition(code === 0 ? 'finished' : 'failed');
        });
```

И метод для записи о провале шага:

```js
    noteStepFailure(step, total, code) {
        this.#write(`шаг ${step} из ${total} завершился с кодом ${code}\n`, 'stderr');
    }
```

- [ ] **Step 6: Прогнать тесты**

Run: `npm test`
Expected: PASS. Прежние тесты про npm-задачи не должны измениться по смыслу — только `npmCommand` → `spec`.

- [ ] **Step 7: Коммит**

```bash
git add src/task-runner.js test/task-runner.test.js test/ui-smoke.test.js
git commit -m "refactor(task): общая спека команды и цепочки шагов"
```

---

### Task 6: `DockerCommand` — спека команды docker

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/docker.test.js`

**Interfaces:**
- Consumes: `DockerCli` (Task 1).
- Produces: `DockerCommand` — конструктор `({ label, target, service = null })`; методы `label()`, `spawnTarget()`, `args()`; поля `command` (равен `label`), `workspace` (равен `service`), `runMode: 'default'`. Нужен, чтобы одиночная команда docker выглядела для `Task` так же, как `NpmCommand`.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/docker.test.js`:

```js
test('DockerCommand выглядит для задачи так же, как NpmCommand', () => {
    const target = new DockerCli({ composeFile: '/c.yml' }).logs('api');
    const spec = new DockerCommand({ label: 'logs api', target, service: 'api' });

    assert.equal(spec.label(), 'logs api');
    assert.deepEqual(spec.spawnTarget(), target);
    assert.deepEqual(spec.args(), target.args);
    assert.equal(spec.workspace, 'api');
    assert.equal(spec.runMode, 'default');
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/docker.test.js`
Expected: FAIL — `DockerCommand is not defined`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавить в `src/task-runner.js`:

```js
/** Одиночная команда docker в виде спеки задачи. */
class DockerCommand {
    constructor({ label, target, service = null }) {
        this.text = label;
        this.target = target;
        this.workspace = service;
        this.command = label;
        this.runMode = 'default';
    }

    label() {
        return this.text;
    }

    args() {
        return this.target.args;
    }

    spawnTarget() {
        return this.target;
    }
}
```

Добавить `DockerCommand` в `module.exports` и в `TaskManager` метод:

```js
    /** Одна команда docker как задача: логи, рестарт, стоп. */
    startDocker({ label, target, service = null }) {
        const spec = new DockerCommand({ label, target, service });
        const task = new Task({ id: this.idFactory(), spec, ...this.taskOptions });
        task.attach(this.#spawn(target));
        task.on('status', () => this.emit('changed'));
        this.items.push(task);
        this.emit('changed');
        return task;
    }
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 1 новый тест.

- [ ] **Step 5: Коммит**

```bash
git add src/task-runner.js test/docker.test.js
git commit -m "feat(docker): DockerCommand и startDocker"
```

---

### Task 7: Реестр GitLab и `ImageCatalog`

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/docker.test.js`

**Interfaces:**
- Consumes: `GitLabClient` (существующий), `DockerCli`, `DockerRunner`, `parseImagesOutput`.
- Produces:
  - `GitLabClient.registryRepositories()` → массив репозиториев реестра; `GitLabClient.registryTag(repositoryId, tagName)` → `{ name, digest, created_at }`.
  - `RegistryLookup` — конструктор `({ client, repo })`; метод `async tagDigest(tag)` → `{ digest, createdAt } | null`. Находит id репозитория реестра по совпадению `location`/`path` с `repo` (один раз, потом кеширует) и берёт digest тега. Именно этот объект `ImageCatalog` получает как `registry` — сам он про GitLab не знает.
  - `ImageCatalog` — конструктор `({ cli, runner, registry = null })`; метод `async build({ repo, tag, container, registry = this.registry })` (реестр можно передать на вызов: он зависит от репозитория конкретного сервиса) → `{ items, registryReason }`, где `items` = `{ digest, tags: string[], sources: string[], createdAt: Date|null, isCurrent: boolean }[]`, отсортированные по дате вниз, дедуп по digest.
  - `ImageCatalog.currentDigest({ container, repo })` → digest запущенного образа или `null`.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/docker.test.js`:

```js
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

    await client.registryTag(7, 'api');

    assert.match(calls[0], /\/registry\/repositories\/7\/tags\/api$/);
});

function catalogFixture({ registry = null } = {}) {
    const runs = [];
    const runner = {
        run: (target) => {
            runs.push(target.args.join(' '));
            const args = target.args.join(' ');
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
            if (args.startsWith('inspect')) {
                return { status: 0, stdout: 'sha256:imageid\n', stderr: '' };
            }
            if (args.startsWith('image inspect')) {
                return { status: 0, stdout: '["repo/app@sha256:bbb"]\n', stderr: '' };
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

    const { items } = await catalog.build({
        repo: 'repo/app',
        tag: 'api',
        container: 'api-1',
    });

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
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/docker.test.js`
Expected: FAIL — `client.registryTag is not a function`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавить в `GitLabClient`:

```js
    registryRepositories() {
        return this.request('/registry/repositories', { tags: 'true', per_page: '100' });
    }

    registryTag(repositoryId, tagName) {
        return this.request(`/registry/repositories/${repositoryId}/tags/${tagName}`);
    }
```

Добавить классы:

```js
/**
 * Мостик между GitLab и каталогом образов: находит id репозитория реестра по его
 * имени и отдаёт digest тега. Список репозиториев запрашивается один раз.
 */
class RegistryLookup {
    constructor({ client, repo }) {
        this.client = client;
        this.repo = repo;
        this.repositoryId = null;
    }

    async #findRepositoryId() {
        if (this.repositoryId !== null) {
            return this.repositoryId;
        }
        const repositories = await this.client.registryRepositories();
        const found = (Array.isArray(repositories) ? repositories : []).find((repository) => {
            const location = String(repository.location ?? repository.path ?? '');
            return location === this.repo || location.endsWith(`/${this.repo}`);
        });
        this.repositoryId = found ? found.id : null;
        return this.repositoryId;
    }

    async tagDigest(tag) {
        const repositoryId = await this.#findRepositoryId();
        if (repositoryId === null) {
            return null;
        }
        const details = await this.client.registryTag(repositoryId, tag);
        if (!details?.digest) {
            return null;
        }
        const createdAt = new Date(details.created_at ?? '');
        return {
            digest: details.digest,
            createdAt: Number.isNaN(createdAt.getTime()) ? null : createdAt,
        };
    }
}

/**
 * Кандидаты для откта. Основной источник — локальный кеш: там лежат прежние
 * образы, потерявшие тег после нового пуша. Реестр отдаёт только текущий digest
 * тега, поэтому он справочный, а не исторический.
 */
class ImageCatalog {
    constructor({ cli, runner, registry = null }) {
        this.cli = cli;
        this.runner = runner;
        this.registry = registry;
    }

    currentDigest({ container, repo }) {
        const inspected = this.runner.run(this.cli.inspectContainerImage(container));
        if (inspected.status !== 0) {
            return null;
        }
        const imageId = inspected.stdout.trim();
        if (!imageId) {
            return null;
        }
        const digests = this.runner.run(this.cli.imageDigests(imageId));
        if (digests.status !== 0) {
            return null;
        }
        let references = [];
        try {
            references = JSON.parse(digests.stdout.trim() || '[]');
        } catch {
            return null;
        }
        const match = references.find((reference) => String(reference).startsWith(`${repo}@`));
        return match ? String(match).split('@')[1] : null;
    }

    async build({ repo, tag, container, registry = this.registry }) {
        const local = this.runner.run(this.cli.images(repo));
        const byDigest = new Map();
        if (local.status === 0) {
            for (const image of parseImagesOutput(local.stdout)) {
                byDigest.set(image.digest, {
                    digest: image.digest,
                    tags: image.tag ? [image.tag] : [],
                    sources: ['local'],
                    createdAt: image.createdAt,
                    isCurrent: false,
                });
            }
        }

        let registryReason = '';
        if (registry) {
            try {
                const found = await registry.tagDigest(tag);
                if (found?.digest) {
                    const existing = byDigest.get(found.digest);
                    if (existing) {
                        if (!existing.sources.includes('registry')) {
                            existing.sources.push('registry');
                        }
                    } else {
                        byDigest.set(found.digest, {
                            digest: found.digest,
                            tags: [tag],
                            sources: ['registry'],
                            createdAt: found.createdAt ?? null,
                            isCurrent: false,
                        });
                    }
                }
            } catch (error) {
                registryReason = error.message;
            }
        }

        const current = container ? this.currentDigest({ container, repo }) : null;
        if (current && byDigest.has(current)) {
            byDigest.get(current).isCurrent = true;
        }

        const items = [...byDigest.values()].sort((a, b) => {
            const left = a.createdAt ? a.createdAt.getTime() : 0;
            const right = b.createdAt ? b.createdAt.getTime() : 0;
            return right - left;
        });
        return { items, registryReason };
    }
}
```

Добавить `ImageCatalog` и `RegistryLookup` в `module.exports`.

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 4 новых теста.

- [ ] **Step 5: Коммит**

```bash
git add src/task-runner.js test/docker.test.js
git commit -m "feat(docker): каталог образов и реестр GitLab"
```

---

### Task 8: Секция Compose в левой колонке и список контейнеров справа

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/ui-smoke.test.js`

**Interfaces:**
- Consumes: `ComposeStore` (Task 4), `SidePanelModel`, `HomeView` (существующие).
- Produces:
  - `SidePanelModel` принимает `compose` (экземпляр `ComposeStore`) и добавляет секцию: заголовок `🐳 Compose` и строку `kind: 'compose'` с ключом `compose:<name>`.
  - `HomeView.rightContext()` отдаёт `'containers'`, когда выбрана строка compose.
  - `HomeView`: состояние пункта получает `containers: { filter: '', selectedService: null }`; методы `visibleContainers()`, `containerCursor()`, `selectedContainer()`, `moveContainerCursor(delta)`, `renderContainers()`, `handleContainersKey(chunk, key)`.
  - Первая строка списка — псевдосервис `{ service: null, label: 'весь проект (N)' }`.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/ui-smoke.test.js` — расширить `bootstrap`, чтобы он поднимал `ComposeStore` с фейковым runner-ом, и добавить тесты:

```js
const {
    ComposeStore,
    ComposeProject,
    DockerCli,
    RegistryLookup,
} = require('../src/task-runner.js');

function composeStub() {
    const project = new ComposeProject({
        file: '/srv/app/docker-compose.yml',
        dir: '/srv/app',
        name: 'vkboss-light',
    });
    return new ComposeStore({
        project,
        cli: new DockerCli({ composeFile: project.file }),
        runner: {
            run: () => ({
                status: 0,
                stdout: [
                    '{"Service":"gptboss-llm","Name":"gptboss-llm","State":"running","Status":"Up 3 days","Image":"repo/app:gptboss-llm"}',
                    '{"Service":"gptboss-chat","Name":"gptboss-chat","State":"running","Status":"Up 3 days","Image":"repo/app:gptboss-chat"}',
                    '{"Service":"gptboss-history","Name":"gptboss-history","State":"exited","Status":"Exited (1) 2 minutes ago","Image":"repo/app:gptboss-history","ExitCode":1}',
                ].join('\n'),
                stderr: '',
            }),
        },
    });
}

test('секция compose: строка проекта слева, контейнеры справа', async () => {
    const compose = composeStub();
    const { home, cleanup } = bootstrap({ compose });
    try {
        await compose.refresh();
        home.model.rebuild();
        home.render();

        assert.match(home.side.content, /Compose/);
        assert.match(home.side.content, /vkboss-light\s+2\/3/);

        home.model.selectKey('compose:vkboss-light');
        home.render();
        assert.equal(home.rightContext(), 'containers');
        assert.match(home.right.content, /весь проект \(3\)/);
        assert.match(home.right.content, /gptboss-llm/);
        assert.match(home.right.content, /Exited \(1\)/);
    } finally {
        cleanup();
    }
});

test('буквы фильтруют контейнеры и ничего не запускают', async () => {
    const compose = composeStub();
    const { app, home, press, type, cleanup } = bootstrap({ compose });
    try {
        await compose.refresh();
        home.model.selectKey('compose:vkboss-light');
        home.render();
        press(null, 'right');

        type('hist');

        assert.equal(home.containers.filter, 'hist');
        assert.deepEqual(
            home.visibleContainers()
                .filter((row) => row.service)
                .map((row) => row.service),
            ['gptboss-history']
        );
        assert.equal(app.manager.tasks().length, 0, 'ни одна команда не ушла');
        assert.equal(app.stack.depth, 1, 'модалок нет');
    } finally {
        cleanup();
    }
});

test('состояние секции compose помнится: фильтр и выбранный контейнер', async () => {
    const compose = composeStub();
    const { home, press, type, cleanup } = bootstrap({ compose });
    try {
        await compose.refresh();
        home.model.selectKey('compose:vkboss-light');
        home.render();
        press(null, 'right');
        type('chat');
        press(null, 'down');
        const chosen = home.selectedContainer()?.service;

        home.model.selectKey('command:build');
        home.render();
        home.model.selectKey('compose:vkboss-light');
        home.render();

        assert.equal(home.containers.filter, 'chat', 'фильтр восстановлен');
        assert.equal(home.selectedContainer()?.service, chosen, 'выбор восстановлен');
    } finally {
        cleanup();
    }
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/ui-smoke.test.js`
Expected: FAIL — `bootstrap` не знает про `compose`, `home.containers` не определён.

- [ ] **Step 3: Провести compose через приложение и модель**

В `TuiApp.constructor` добавить параметр `compose = null` и поле:

```js
        this.compose = compose ?? createComposeStore({ startDir: repoRoot });
```

В `TuiApp.run` подписаться так же, как на `pipelines`:

```js
        this.compose.on('changed', () => {
            const view = this.stack.top();
            if (view instanceof HomeView) {
                view.model.rebuild();
                view.render();
            }
            this.render();
        });
```

и после `void this.pipelines.refresh();` добавить `void this.compose.refresh();`.

В `SidePanelModel.constructor` добавить `compose = null`, сохранить в поле, и в `rebuild()` после секции пайплайнов вызвать `this.#pushComposeRows(rows)`:

```js
    #pushComposeRows(rows) {
        const store = this.compose;
        if (!store?.isEnabled()) {
            return;
        }
        const { up, total } = store.counters();
        rows.push({
            kind: 'header',
            key: 'header:compose',
            label: '🐳 Compose',
            selectable: false,
        });
        rows.push({
            kind: 'compose',
            key: `compose:${store.project.name}`,
            label: `  ${store.project.name}  ${up}/${total}`,
            selectable: true,
            compose: store,
        });
    }
```

В `HomeView.constructor` передать `compose: app.compose` в `SidePanelModel`.

- [ ] **Step 4: Реализовать правую колонку для контейнеров**

В `HomeView.freshState` добавить поле:

```js
            containers: { filter: '', selectedService: null },
```

В `syncActiveKey` и `captureState` добавить `containers` рядом с `services` и `jobs`.

В `rightContext()` добавить ветку перед проверкой `pipeline`:

```js
        if (kind === 'compose') {
            return 'containers';
        }
```

Добавить методы:

```js
    /** Первая строка — псевдосервис для операций над всем проектом. */
    visibleContainers() {
        const store = this.app.compose;
        if (!store?.isEnabled()) {
            return [];
        }
        const needle = this.containers.filter.toLowerCase();
        const matched = store
            .containers()
            .filter((container) => container.service.toLowerCase().includes(needle));
        return [
            { service: null, label: `весь проект (${store.containers().length})` },
            ...matched.map((container) => ({ ...container, label: container.service })),
        ];
    }

    containerCursor() {
        const rows = this.visibleContainers();
        const found = rows.findIndex((row) => row.service === this.containers.selectedService);
        return found >= 0 ? found : 0;
    }

    selectedContainer() {
        return this.visibleContainers()[this.containerCursor()] ?? null;
    }

    moveContainerCursor(delta) {
        const rows = this.visibleContainers();
        if (rows.length === 0) {
            return;
        }
        const next = Math.max(0, Math.min(rows.length - 1, this.containerCursor() + delta));
        this.containers.selectedService = rows[next].service;
    }

    renderContainers() {
        const store = this.app.compose;
        const { up, total } = store.counters();
        const filter = this.containers.filter ? `/${this.containers.filter}` : 'без фильтра';
        this.right.setLabel(` ${store.project.name} • ${up}/${total} up • ${filter} `);
        if (store.status === 'error') {
            this.right.setContent(`{red-fg}${store.reason}{/}`);
            return;
        }
        const rows = this.visibleContainers();
        const cursor = this.containerCursor();
        const lines = rows.map((row, position) => {
            const active = this.focus === 'right' && position === cursor;
            const text = row.service === null ? `▸ ${row.label}` : this.containerLine(row);
            return active ? `{inverse}${stripTags(text)}{/}` : text;
        });
        this.right.setContent(lines.join('\n'));
        if (this.focus === 'right') {
            this.right.scrollTo(cursor);
        }
    }

    containerLine(container) {
        const icon = container.state === 'running' ? '{green-fg}●{/}' : '{red-fg}✗{/}';
        const pinned = this.app.compose.isPinned(container.service)
            ? '  {yellow-fg}⇤ локально переопределён{/}'
            : '';
        return `${icon} ${container.service}  {grey-fg}${container.status}{/}${pinned}`;
    }

    handleContainersKey(chunk, key) {
        const name = key?.name;
        if (name === 'up' || name === 'down') {
            this.moveContainerCursor(name === 'down' ? 1 : -1);
            this.render();
            return true;
        }
        if (name === 'backspace') {
            if (this.containers.filter.length === 0) {
                return false;
            }
            this.containers.filter = this.containers.filter.slice(0, -1);
            this.render();
            return true;
        }
        if (!key?.ctrl && !key?.meta && typeof chunk === 'string' && chunk.length === 1 && chunk >= ' ') {
            this.containers.filter += chunk;
            this.render();
            return true;
        }
        return false;
    }
```

В `renderRight()` добавить ветку `containers`, а в `handleKey` — вызов `handleContainersKey`, рядом с `handleServicesKey` и `handleJobsKey`:

```js
        if (this.focus === 'right' && this.rightContext() === 'containers') {
            if (this.handleContainersKey(chunk, key)) {
                return true;
            }
        }
```

В `hotkeys()` добавить ветку:

```js
        if (this.focus === 'right' && context === 'containers') {
            return 'печатай фильтр  ↑↓ контейнер  Enter действия  Tab/←/Esc назад  Ctrl+C выход';
        }
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 3 новых теста.

- [ ] **Step 6: Коммит**

```bash
git add src/task-runner.js test/ui-smoke.test.js
git commit -m "feat(docker): секция compose и список контейнеров"
```

---

### Task 9: Меню действий, подтверждения, задачи

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/ui-smoke.test.js`

**Interfaces:**
- Consumes: `PickerView`, `ConfirmView`, `TaskManager.startDocker` (Task 6), `TaskManager.startSequence` (Task 5), `DockerCli`.
- Produces:
  - `HomeView.openContainerMenu(row)` — открывает `PickerView` с пунктами.
  - `TuiApp.composeAction({ action, service })` — выполняет пункт: `logs`, `update`, `images`, `restart`, `stop`, `update-all`, `logs-all`.
  - Все действия, кроме `logs`, `logs-all` и `images`, проходят через `ConfirmView` с текстом из точных команд; `TuiApp.confirmCommands({ title, targets, note = '' })` — общий помощник.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/ui-smoke.test.js`:

```js
test('Enter на контейнере открывает меню, а не запускает', async () => {
    const compose = composeStub();
    const { app, home, press, pressEnter, cleanup } = bootstrap({ compose });
    try {
        await compose.refresh();
        home.model.selectKey('compose:vkboss-light');
        home.render();
        press(null, 'right');
        press(null, 'down');

        pressEnter();

        assert.equal(app.stack.depth, 2, 'открылось меню');
        assert.match(app.stack.top().title, /gptboss-llm/);
        assert.deepEqual(
            app.stack.top().items.map((item) => item.value),
            ['logs', 'update', 'images', 'restart', 'stop']
        );
        assert.equal(app.manager.tasks().length, 0, 'ничего не запущено');
    } finally {
        cleanup();
    }
});

test('пункт «Логи» создаёт задачу с командой docker compose logs', async () => {
    const compose = composeStub();
    const { app, home, press, pressEnter, cleanup } = bootstrap({ compose });
    try {
        await compose.refresh();
        home.model.selectKey('compose:vkboss-light');
        home.render();
        press(null, 'right');
        press(null, 'down');
        pressEnter();

        pressEnter();

        assert.equal(app.stack.depth, 1, 'меню закрылось');
        const task = app.manager.tasks()[0];
        assert.match(task.spec.label(), /logs gptboss-llm/);
        assert.deepEqual(task.spec.spawnTarget().args.slice(-5), [
            'logs',
            '-f',
            '--tail',
            '200',
            'gptboss-llm',
        ]);
    } finally {
        cleanup();
    }
});

test('пункт «Обновить» требует подтверждения и показывает команды', async () => {
    const compose = composeStub();
    const { app, home, press, pressEnter, cleanup } = bootstrap({ compose });
    try {
        await compose.refresh();
        home.model.selectKey('compose:vkboss-light');
        home.render();
        press(null, 'right');
        press(null, 'down');
        pressEnter();
        press(null, 'down');

        pressEnter();

        assert.ok(app.stack.top() instanceof ConfirmView, 'спросил подтверждение');
        assert.match(app.stack.top().text, /pull gptboss-llm/);
        assert.match(app.stack.top().text, /up -d gptboss-llm/);
        assert.equal(app.manager.tasks().length, 0);

        press(null, 'n');
        assert.equal(app.manager.tasks().length, 0, 'отмена ничего не запустила');
    } finally {
        cleanup();
    }
});

test('подтверждённое обновление запускает цепочку pull → up -d', async () => {
    const compose = composeStub();
    const { app, home, press, pressEnter, cleanup } = bootstrap({ compose });
    try {
        await compose.refresh();
        home.model.selectKey('compose:vkboss-light');
        home.render();
        press(null, 'right');
        press(null, 'down');
        pressEnter();
        press(null, 'down');
        pressEnter();

        press(null, 'y');

        const task = app.manager.tasks()[0];
        assert.equal(task.spec.size, 2, 'цепочка из двух шагов');
        assert.deepEqual(task.spec.targets[0].args.slice(-2), ['pull', 'gptboss-llm']);
        assert.deepEqual(task.spec.targets[1].args.slice(-3), ['up', '-d', 'gptboss-llm']);
    } finally {
        cleanup();
    }
});

test('строка «весь проект» даёт обновление всего с числом сервисов', async () => {
    const compose = composeStub();
    const { app, home, press, pressEnter, cleanup } = bootstrap({ compose });
    try {
        await compose.refresh();
        home.model.selectKey('compose:vkboss-light');
        home.render();
        press(null, 'right');

        pressEnter();
        assert.deepEqual(
            app.stack.top().items.map((item) => item.value),
            ['update-all', 'logs-all']
        );

        pressEnter();
        assert.ok(app.stack.top() instanceof ConfirmView);
        assert.match(app.stack.top().text, /3 сервис/);
        press(null, 'y');

        const task = app.manager.tasks()[0];
        assert.deepEqual(task.spec.targets[0].args.slice(-1), ['pull']);
        assert.deepEqual(task.spec.targets[1].args.slice(-2), ['up', '-d']);
    } finally {
        cleanup();
    }
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/ui-smoke.test.js`
Expected: FAIL — Enter по контейнеру не открывает меню.

- [ ] **Step 3: Реализовать меню**

В `HomeView.handleContainersKey` добавить **перед** веткой печатных символов:

```js
        if (CONFIRM_KEYS.has(name)) {
            const row = this.selectedContainer();
            if (row) {
                this.openContainerMenu(row);
            }
            return true;
        }
```

Добавить метод:

```js
    /** Действия — пунктами меню: буквы в этой колонке заняты фильтром. */
    openContainerMenu(row) {
        const items =
            row.service === null
                ? [
                      { label: 'Обновить всё (pull + up -d)', value: 'update-all' },
                      { label: 'Логи всего проекта', value: 'logs-all' },
                  ]
                : [
                      { label: 'Логи', value: 'logs' },
                      { label: 'Обновить (pull + up -d)', value: 'update' },
                      { label: 'Образы и откат', value: 'images' },
                      { label: 'Рестарт', value: 'restart' },
                      { label: 'Стоп', value: 'stop' },
                  ];
        this.app.push(
            new PickerView(this.app, {
                title: row.service ?? 'весь проект',
                hint: '↑↓ выбор  Enter выполнить  Backspace назад',
                items,
                onPick: (action) => {
                    this.app.pop();
                    this.app.composeAction({ action, service: row.service });
                },
            })
        );
    }
```

- [ ] **Step 4: Реализовать действия в `TuiApp`**

```js
    /** Общий диалог: показываем ровно те команды, которые уйдут в docker. */
    confirmCommands({ title, targets, note = '', onConfirm }) {
        const commands = targets
            .map((target) => `${target.command} ${target.args.join(' ')}`)
            .join('\n');
        this.push(
            new ConfirmView(this, {
                title,
                text: note ? `${commands}\n\n${note}` : commands,
                onConfirm: () => {
                    this.pop();
                    onConfirm();
                },
            })
        );
    }

    composeAction({ action, service }) {
        const store = this.compose;
        if (!store?.isEnabled()) {
            return;
        }
        const cli = store.cli;

        if (action === 'logs') {
            this.manager.startDocker({
                label: `logs ${service}`,
                target: cli.logs(service),
                service,
            });
            return;
        }
        if (action === 'logs-all') {
            this.manager.startDocker({ label: 'logs всего проекта', target: cli.logsAll() });
            return;
        }
        if (action === 'images') {
            void this.openImageCatalog(service);
            return;
        }
        if (action === 'update') {
            const targets = [cli.pull(service), cli.up(service)];
            this.confirmCommands({
                title: `Обновить ${service}`,
                targets,
                onConfirm: () => {
                    const task = this.manager.startSequence({
                        label: `обновить ${service}`,
                        targets,
                        workspace: service,
                    });
                    task.once('status', () => {
                        store.unpin(service);
                        void store.refresh();
                    });
                },
            });
            return;
        }
        if (action === 'update-all') {
            const targets = [cli.pullAll(), cli.upAll()];
            this.confirmCommands({
                title: `Обновить ${store.project.name}`,
                targets,
                note: `Затронет ${store.counters().total} сервисов.`,
                onConfirm: () => {
                    const task = this.manager.startSequence({
                        label: `обновить ${store.project.name}`,
                        targets,
                    });
                    task.once('status', () => void store.refresh());
                },
            });
            return;
        }
        if (action === 'restart' || action === 'stop') {
            const target = action === 'restart' ? cli.restart(service) : cli.stop(service);
            this.confirmCommands({
                title: `${action === 'restart' ? 'Рестарт' : 'Стоп'} ${service}`,
                targets: [target],
                onConfirm: () => {
                    const task = this.manager.startDocker({
                        label: `${action} ${service}`,
                        target,
                        service,
                    });
                    task.once('status', () => void store.refresh());
                },
            });
        }
    }
```

Заглушка `openImageCatalog` (полная реализация — Task 10):

```js
    async openImageCatalog(service) {
        this.notify('Каталог образов появится в следующей задаче.');
    }
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 5 новых тестов.

- [ ] **Step 6: Коммит**

```bash
git add src/task-runner.js test/ui-smoke.test.js
git commit -m "feat(docker): меню действий, подтверждения и задачи"
```

---

### Task 10: Каталог образов и откат

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/ui-smoke.test.js`

**Interfaces:**
- Consumes: `ImageCatalog` (Task 7), `PickerView`, `ConfirmView`, `ComposeStore.pin`.
- Produces:
  - `TuiApp.openImageCatalog(service)` — полная реализация: собирает каталог, открывает `PickerView`, по выбору просит подтверждение и запускает цепочку.
  - `imageReferenceForService(container)` → `{ repo, tag }` из строки образа контейнера (`repo/app:tag`).
  - `rollbackTargets({ cli, repo, tag, digest, service, alreadyLocal })` → массив шагов: `pull repo@digest` (только если образа нет локально), `tag digest repo:tag`, `up -d --no-deps service`.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/ui-smoke.test.js`:

```js
const { imageReferenceForService, rollbackTargets, DockerCli: Cli } = require('../src/task-runner.js');

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
    const cli = new Cli({ composeFile: '/c.yml' });
    const withPull = rollbackTargets({
        cli,
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
        cli,
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

test('откат: каталог, подтверждение с digest, цепочка и пометка', async () => {
    const compose = composeStub();
    const { app, home, press, pressEnter, cleanup } = bootstrap({
        compose,
        imageCatalogImpl: {
            build: async () => ({
                items: [
                    {
                        digest: 'sha256:aaa',
                        tags: ['gptboss-llm'],
                        sources: ['local'],
                        createdAt: new Date('2026-08-12T21:04:00Z'),
                        isCurrent: true,
                    },
                    {
                        digest: 'sha256:bbb',
                        tags: [],
                        sources: ['local'],
                        createdAt: new Date('2026-08-11T18:22:00Z'),
                        isCurrent: false,
                    },
                ],
                registryReason: '',
            }),
        },
    });
    try {
        await compose.refresh();
        home.model.selectKey('compose:vkboss-light');
        home.render();
        press(null, 'right');
        press(null, 'down');
        pressEnter();
        press(null, 'down');
        press(null, 'down');

        pressEnter();
        await new Promise(setImmediate);
        await new Promise(setImmediate);

        assert.match(app.stack.top().title, /Образы gptboss-llm/);
        assert.match(app.stack.top().items[0].label, /запущен сейчас/);
        press(null, 'down');
        pressEnter();

        assert.ok(app.stack.top() instanceof ConfirmView);
        assert.match(app.stack.top().text, /sha256:bbb/);
        assert.match(app.stack.top().text, /локальный тег/);
        press(null, 'y');

        const task = app.manager.tasks()[0];
        assert.deepEqual(
            task.spec.targets.map((target) => target.args[0]),
            ['tag', 'compose'],
            'образ локальный — pull пропущен'
        );
        assert.equal(compose.isPinned('gptboss-llm'), true, 'сервис помечен');
    } finally {
        cleanup();
    }
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/ui-smoke.test.js`
Expected: FAIL — `imageReferenceForService is not a function`.

- [ ] **Step 3: Написать вспомогательные функции**

Добавить в `src/task-runner.js`:

```js
/** Из "registry.gitlab.com/g/app:api" получаем репозиторий и тег. */
function imageReferenceForService(container) {
    const image = String(container?.image ?? '').trim();
    if (!image) {
        return null;
    }
    const lastColon = image.lastIndexOf(':');
    const lastSlash = image.lastIndexOf('/');
    if (lastColon > lastSlash) {
        return { repo: image.slice(0, lastColon), tag: image.slice(lastColon + 1) };
    }
    return { repo: image, tag: 'latest' };
}

/**
 * Шаги откта. Compose ссылается на изменяемый тег, поэтому вместо правки файла
 * перевешиваем тег на нужный digest и поднимаем сервис.
 */
function rollbackTargets({ cli, repo, tag, digest, service, alreadyLocal }) {
    const reference = `${repo}@${digest}`;
    const targets = [];
    if (!alreadyLocal) {
        targets.push(cli.pullImage(reference));
    }
    targets.push(cli.tag(reference, `${repo}:${tag}`));
    targets.push(cli.up(service, { noDeps: true }));
    return targets;
}
```

Добавить обе функции в `module.exports`.

- [ ] **Step 4: Реализовать `openImageCatalog`**

Заменить заглушку в `TuiApp`:

```js
    async openImageCatalog(service) {
        const store = this.compose;
        const container = store.containers().find((item) => item.service === service);
        const reference = imageReferenceForService(container);
        if (!reference) {
            this.notify(`У ${service} не разобрать образ — откат недоступен.`);
            return;
        }
        this.notify(`Собираю список образов ${reference.repo}…`);
        // Реестр зависит от репозитория конкретного сервиса, поэтому мостик
        // создаётся здесь, на клиенте GitLab от секции пайплайнов. Нет токена —
        // нет реестра, и это не мешает: локальные образы уже дают откат.
        const registry = this.pipelines?.client
            ? new RegistryLookup({ client: this.pipelines.client, repo: reference.repo })
            : null;
        const { items, registryReason } = await this.imageCatalog.build({
            repo: reference.repo,
            tag: reference.tag,
            container: container.name,
            registry,
        });
        if (items.length === 0) {
            this.notify(`Образов не нашлось${registryReason ? `: ${registryReason}` : ''}.`);
            return;
        }
        this.notice = registryReason ? `Реестр недоступен: ${registryReason}` : null;
        this.push(
            new PickerView(this, {
                title: `Образы ${service}`,
                hint: '↑↓ выбор  Enter откатить  Backspace назад',
                items: items.map((item) => ({
                    label: [
                        item.isCurrent ? '●' : ' ',
                        item.digest.slice(0, 19),
                        item.sources.includes('local') ? 'локально' : 'реестр',
                        item.createdAt ? item.createdAt.toLocaleString() : 'дата неизвестна',
                        item.isCurrent ? '← запущен сейчас' : '',
                    ]
                        .filter((part) => part !== '')
                        .join('  '),
                    value: item,
                })),
                onPick: (item) => {
                    this.pop();
                    this.confirmRollback({ service, reference, item });
                },
            })
        );
    }

    confirmRollback({ service, reference, item }) {
        const store = this.compose;
        const targets = rollbackTargets({
            cli: store.cli,
            repo: reference.repo,
            tag: reference.tag,
            digest: item.digest,
            service,
            alreadyLocal: item.sources.includes('local'),
        });
        this.confirmCommands({
            title: `Откат ${service}`,
            targets,
            note: [
                `Образ ${item.digest.slice(0, 19)} от ${
                    item.createdAt ? item.createdAt.toLocaleString() : 'неизвестной даты'
                }.`,
                'После откта локальный тег разойдётся с реестром: следующий «Обновить»',
                'осознанно уедет вперёд на свежий образ.',
            ].join('\n'),
            onConfirm: () => {
                const task = this.manager.startSequence({
                    label: `откат ${service}`,
                    targets,
                    workspace: service,
                });
                store.pin(service);
                task.once('status', () => void store.refresh());
            },
        });
    }
```

В `TuiApp.constructor` добавить параметр `imageCatalogImpl = null` и поле:

```js
        // Реестр берём из того же клиента GitLab, что и пайплайны: если токена нет,
        // каталог обойдётся локальными образами.
        this.imageCatalog =
            imageCatalogImpl ??
            (this.compose.isEnabled()
                ? new ImageCatalog({
                      cli: this.compose.cli,
                      runner: this.compose.runner,
                      registry: null,
                  })
                : null);
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 3 новых теста.

- [ ] **Step 6: Коммит**

```bash
git add src/task-runner.js test/ui-smoke.test.js
git commit -m "feat(docker): каталог образов и откат по digest"
```

---

### Task 11: Опрос состояния, справка, README, версия

**Files:**
- Modify: `src/task-runner.js`
- Modify: `README.md`
- Modify: `test/ui-smoke.test.js`
- Modify: `package.json` (версия — через `npm version minor`)

**Interfaces:**
- Consumes: всё из Tasks 1–10.
- Produces: опрос `ps` раз в 5 секунд, пункты в `HelpView`, раздел в README, версия 0.3.0 с тегом.

- [ ] **Step 1: Написать падающий тест на опрос**

Дописать в `test/ui-smoke.test.js`:

```js
test('состояние контейнеров опрашивается по тику, пока секция видна', async () => {
    const compose = composeStub();
    let refreshes = 0;
    compose.refresh = async () => {
        refreshes += 1;
    };
    // tickMs 1000 → каждые 5 тиков должен идти опрос ps.
    const { app, home, cleanup } = bootstrap({ compose, tickMs: 1000 });
    try {
        home.model.rebuild();
        home.model.selectKey('compose:vkboss-light');
        home.render();
        refreshes = 0;

        for (let tick = 0; tick < 5; tick += 1) {
            app.onTick();
        }

        assert.equal(refreshes, 1, 'один опрос за 5 секунд, а не на каждый кадр');
    } finally {
        cleanup();
    }
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/ui-smoke.test.js`
Expected: FAIL — `app.onTick is not a function`.

- [ ] **Step 3: Вынести тик в метод и добавить опрос**

В `TuiApp.run` заменить тело `setInterval` на `this.onTick()` и добавить метод:

```js
    onTick() {
        this.stack.top().tick();
        this.renderStatus();
        this.screen.render();
        this.ticks += 1;
        const every = (ms) => Math.max(1, Math.round(ms / this.tickMs));
        // Пайплайны — раз в 30 с и только пока что-то бежит.
        if (this.ticks % every(30_000) === 0 && this.pipelines.hasRunning()) {
            void this.pipelines.refresh();
        }
        // Контейнеры — раз в 5 с, пока курсор на compose или жива docker-задача.
        if (this.ticks % every(5000) === 0 && this.compose.isEnabled()) {
            const view = this.stack.top();
            const onCompose =
                view instanceof HomeView && view.model.selected()?.kind === 'compose';
            if (onCompose) {
                void this.compose.refresh();
            }
        }
    }
```

- [ ] **Step 4: Хоткей `r` перечитывает состояние контейнеров**

В `HomeView.handleKey`, в ветке `name === 'r'`, к обновлению индекса и пайплайнов добавить:

```js
            void this.app.compose?.refresh();
```

Тест дописать в `test/ui-smoke.test.js`:

```js
test('r перечитывает состояние контейнеров немедленно', async () => {
    const compose = composeStub();
    let refreshes = 0;
    compose.refresh = async () => {
        refreshes += 1;
    };
    const { home, press, cleanup } = bootstrap({ compose });
    try {
        home.model.rebuild();
        home.model.selectKey('compose:vkboss-light');
        home.render();
        refreshes = 0;

        press('r', 'r');

        assert.equal(refreshes, 1);
    } finally {
        cleanup();
    }
});
```

- [ ] **Step 5: Дополнить справку**

В `HelpView` добавить строки:

```js
                '',
                'Docker Compose:',
                '  Enter на контейнере — меню: логи, обновить, образы и откат, рестарт, стоп',
                '  первая строка списка — операции над всем проектом',
                '  всё, что меняет состояние, спрашивает подтверждение',
```

- [ ] **Step 6: Дополнить README**

Добавить раздел перед «Как работает стоп»:

```markdown
## Docker Compose

Если рядом с проектом есть `docker-compose.yml`, слева появляется секция `🐳 Compose`
со строкой проекта, а справа — его контейнеры: состояние, статус, пометка про откат.
Буквы фильтруют список, `Enter` открывает меню действий:

- **Логи** — `docker compose logs -f --tail=200 <сервис>` как обычная задача: поиск по
  `/`, копирование по `y`, режим на весь экран по `z`.
- **Обновить** — `pull` и `up -d` одной задачей с одним логом.
- **Образы и откат** — список образов из локального кеша (там лежат прежние версии,
  потерявшие тег после нового пуша) и текущий digest тега из реестра GitLab. Выбор →
  подтверждение → `pull` нужного digest при необходимости, локальный ретег и
  `up -d --no-deps`. Compose-файл не меняется.
- **Рестарт**, **Стоп** — то же с подтверждением.

Первая строка списка — `весь проект`: обновление всего сразу и логи всех сервисов.

Всё, что меняет состояние docker, показывает точные команды и спрашивает
подтверждение. Читаются `ps`, `images`, `inspect` и реестр — без спроса, раз в 5
секунд, пока курсор стоит на секции.

**Про откат честно:** после ретега локальный тег указывает не на то, что в реестре,
и сервис помечается `⇤ локально переопределён`. Следующее «Обновить» осознанно
уедет вперёд на свежий образ, и пометка снимется. Постоянного закрепления digest в
compose-файле нет.
```

- [ ] **Step 7: Прогнать всё и поднять версию**

Run: `npm test`
Expected: PASS, все тесты.

Run: `node bin/packer-commander.js --self-check`
Expected: код 0.

Run: `npm version minor -m "chore: версия %s"`
Expected: `v0.3.0`.

- [ ] **Step 8: Коммит и пуш**

```bash
git add -A
git commit -m "feat(docker): опрос состояния, справка и README"
git push origin main --follow-tags
```

---

## Соответствие спеке

| Требование спеки | Задача |
|---|---|
| `DockerCli` — argv всех команд, без shell | 1 |
| Читающий раннер для `ps`/`images`/`inspect` | 1 |
| `ComposeProject.find`, имя из `name:` без парсера YAML | 2 |
| `parsePsOutput`: построчный JSON, массив, регистр полей, мусор | 3 |
| `parseImagesOutput`: digest, `<none>`, даты | 3 |
| `ComposeStore`: статусы, `counters()`, `pinned`, только чтение | 4 |
| Общая спека команды вместо `NpmCommand` в `Task` | 5 |
| `startSequence`: один лог, прерывание на ненулевом коде | 5 |
| `DockerCommand` и одиночные docker-задачи | 6 |
| Реестр GitLab (`read_registry`), `ImageCatalog`, работа без реестра | 7 |
| Секция `🐳 Compose`, список контейнеров, фильтр буквами | 8 |
| Состояние секции помнится (фильтр, выбранный контейнер) | 8 |
| Строка `весь проект` | 8, 9 |
| Меню действий вместо буквенных хоткеев | 9 |
| Подтверждения с точным списком команд | 9 |
| Логи как обычная задача | 9 |
| Каталог образов, откат через ретег, пометка `⇤` | 10 |
| Опрос `ps` раз в 5 секунд, `r` — немедленно | 11 |
| Справка и README | 11 |
