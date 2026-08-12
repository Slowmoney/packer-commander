# Каталог проектов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать раннеру вид на каталог проектов (`/opt`): список проектов слева, их цели make, shell-скрипты, npm-скрипты и контейнеры справа, запуск задачей или в терминале с подтверждением.

**Architecture:** Ядро прирастает `ProjectIndex`, `MakefileTargets`, `MakeCommand`, `ShellCommand`, `projectRunnables` — всё без blessed и на инжектированных `fs`/`spawn`. `ComposeStore` переезжает из «один на приложение» в карту по проекту с ленивым созданием. UI получает контекст `runnables` рядом с существующими `services`, `containers`, `jobs`, `trace`, `log`.

**Tech Stack:** Node 20+ (CommonJS), `blessed@0.1.81`, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-12-projects-make-scripts-design.md`

## Global Constraints

- **Один файл реализации:** всё в `src/task-runner.js`. Тесты — `test/projects.test.js` (новый) и дополнения в `test/ui-smoke.test.js`.
- **Новых зависимостей не добавлять.**
- **Буквы в правой колонке — фильтр.** Все действия через `Enter` и меню. Это правило уже дважды ломалось (`w` = watch, действия docker на буквах) — третьего раза быть не должно.
- **Каждый запуск проходит через `ConfirmView`** с точной командой и рабочей папкой. Никаких списков «безопасных» имён.
- **Скан только на один уровень вниз** плюс сам корень. Рекурсия по `/opt` недопустима.
- **`make -qp` не вызывать** — цели парсятся из текста файла.
- **Ни один тест не зовёт настоящие `make`, `bash`, `docker`.** `spawn`/`spawnSync`/`fs` инжектируются.
- CommonJS, отступ 4 пробела, управляющих байтов в исходнике быть не должно.
- Коммит после каждой задачи; версия поднимается один раз в конце (Task 9).

---

### Task 1: `ProjectIndex`

**Files:**
- Modify: `src/task-runner.js`
- Create: `test/projects.test.js`
- Modify: `package.json` (добавить файл в скрипт `test`)

**Interfaces:**
- Consumes: `COMPOSE_FILENAMES` (существует), `readJsonFile` (существует).
- Produces:
  - `MAKEFILE_NAMES = ['makefile', 'Makefile', 'GNUmakefile']`.
  - `ProjectIndex` — конструктор `({ root, fsImpl = fs })`; методы `refresh(): void`, `projects(): Project[]`, `get(dir): Project|null`, `hasChildren(): boolean`, `reason` (строка с объяснением, если ничего не нашлось).
  - `Project` = `{ name, dir, composeFile: string|null, makefile: string|null, scripts: string[], hasPackageJson: boolean, isRoot: boolean }`.

- [ ] **Step 1: Написать падающий тест**

Создать `test/projects.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProjectIndex } = require('../src/task-runner.js');

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
    assert.deepEqual(crm.scripts.map((script) => path.basename(script)), [
        'check.sh',
        'checkmig.sh',
    ]);
    assert.equal(crm.hasPackageJson, false);

    const factory = index.get(path.join(root, 'content-factory'));
    assert.equal(factory.hasPackageJson, true);
    assert.equal(path.basename(factory.makefile), 'Makefile');
    assert.equal(factory.composeFile, null);

    const rootProject = index.projects()[0];
    assert.equal(rootProject.isRoot, true);
    assert.deepEqual(rootProject.scripts.map((script) => path.basename(script)), [
        'clear-docker.sh',
        'up-all.sh',
    ]);
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
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/projects.test.js`
Expected: FAIL — `ProjectIndex is not a constructor`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавить в `src/task-runner.js` после `ComposeProject`:

```js
const MAKEFILE_NAMES = ['makefile', 'Makefile', 'GNUmakefile'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'tmp']);

/**
 * Каталог проектов: сам корень плюс папки на один уровень вниз, в которых есть
 * хоть что-то запускаемое. Один уровень — сознательно: рекурсия по /opt уперлась
 * бы в тома docker, логи и node_modules.
 */
class ProjectIndex {
    constructor({ root, fsImpl = fs }) {
        this.root = path.resolve(root);
        this.fs = fsImpl;
        this.items = [];
        this.reason = '';
    }

    refresh() {
        const found = [];
        const rootProject = this.#describe(this.root, true);
        if (rootProject) {
            found.push(rootProject);
        }
        for (const entry of this.#readDir(this.root)) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) {
                continue;
            }
            const project = this.#describe(path.join(this.root, entry.name), false);
            if (project) {
                found.push(project);
            }
        }
        const children = found.filter((project) => !project.isRoot);
        this.items = [
            ...found.filter((project) => project.isRoot),
            ...children.sort((a, b) => a.name.localeCompare(b.name)),
        ];
        this.reason = children.length === 0 ? 'Рядом не нашлось проектов с запускаемым.' : '';
    }

    projects() {
        return this.items;
    }

    get(dir) {
        return this.items.find((project) => project.dir === dir) ?? null;
    }

    hasChildren() {
        return this.items.some((project) => !project.isRoot);
    }

    #readDir(dir) {
        try {
            return this.fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return [];
        }
    }

    #describe(dir, isRoot) {
        const entries = this.#readDir(dir);
        const files = new Set(entries.filter((entry) => !entry.isDirectory()).map((e) => e.name));
        const composeName = COMPOSE_FILENAMES.find((name) => files.has(name)) ?? null;
        const makefileName = MAKEFILE_NAMES.find((name) => files.has(name)) ?? null;
        const scripts = [...files]
            .filter((name) => name.endsWith('.sh'))
            .sort((a, b) => a.localeCompare(b))
            .map((name) => path.join(dir, name));
        const pkg = files.has('package.json') ? readJsonFile(path.join(dir, 'package.json'), this.fs) : null;
        const hasPackageJson = Boolean(pkg && Object.keys(pkg.scripts ?? {}).length > 0);

        if (!composeName && !makefileName && scripts.length === 0 && !hasPackageJson) {
            return null;
        }
        return {
            name: isRoot ? `${path.basename(dir)} (корень)` : path.basename(dir),
            dir,
            composeFile: composeName ? path.join(dir, composeName) : null,
            makefile: makefileName ? path.join(dir, makefileName) : null,
            scripts,
            hasPackageJson,
            isRoot,
        };
    }
}
```

Добавить `ProjectIndex` и `MAKEFILE_NAMES` в `module.exports`.

- [ ] **Step 4: Подключить тест-файл**

В `package.json` в скрипт `test` добавить ` test/projects.test.js`.

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: PASS, все прежние плюс 5 новых.

- [ ] **Step 6: Коммит**

```bash
git add src/task-runner.js test/projects.test.js package.json
git commit -m "feat(projects): каталог проектов на один уровень вниз"
```

---

### Task 2: `MakefileTargets.parse`

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/projects.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: `MakefileTargets.parse(text): string[]` — цели в порядке появления, без дублей.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/projects.test.js` (и в деструктуризацию `require`):

```js
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
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/projects.test.js`
Expected: FAIL — `MakefileTargets is not defined`.

- [ ] **Step 3: Написать минимальную реализацию**

```js
// Цель — строка без отступа вида "name:" или "name:: deps". Отсекаем шаблонные
// правила с %, служебные цели с точки и присваивания переменных: ":=", "?=", "+=".
const MAKE_TARGET_LINE = /^([A-Za-z0-9_.\-/]+)\s*::?(?!=)/;

class MakefileTargets {
    static parse(text) {
        const targets = [];
        for (const line of String(text ?? '').split('\n')) {
            if (!line || line.startsWith('\t') || line.startsWith(' ') || line.startsWith('#')) {
                continue;
            }
            const match = line.match(MAKE_TARGET_LINE);
            if (!match) {
                continue;
            }
            const name = match[1];
            if (name.startsWith('.') || name.includes('%')) {
                continue;
            }
            if (!targets.includes(name)) {
                targets.push(name);
            }
        }
        return targets;
    }
}
```

Добавить `MakefileTargets` в `module.exports`.

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 2 новых теста.

- [ ] **Step 5: Коммит**

```bash
git add src/task-runner.js test/projects.test.js
git commit -m "feat(projects): разбор целей makefile"
```

---

### Task 3: `MakeCommand`, `ShellCommand` и запуск с чужой рабочей папкой

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/projects.test.js`

**Interfaces:**
- Consumes: `Task`, `TaskManager` (существуют).
- Produces:
  - `MakeCommand` — конструктор `({ target, dir, projectName })`; `label()` → `make <target> (<projectName>)`, `spawnTarget()` → `{ command: 'make', args: ['-C', dir, target], shell: false, cwd: dir }`, `args()`.
  - `ShellCommand` — конструктор `({ script, dir, projectName, shellPath = 'bash' })`; `label()` → `sh <имя файла> (<projectName>)`, `spawnTarget()` → `{ command: 'bash', args: [script], shell: false, cwd: dir }`, `args()`.
  - `TaskManager.startCommand(spec)` → `Task` — общий запуск любой спеки; `startDocker` становится обёрткой над ним.
  - `TaskManager.runTargetForeground(target)` → код возврата: `spawnSync` со `stdio: 'inherit'` и `cwd` из цели.
  - `TaskManager.#spawn` уважает `target.cwd`, иначе `repoRoot`.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/projects.test.js`:

```js
const { EventEmitter } = require('node:events');

function fakeChild(pid = 555) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    return child;
}

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
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/projects.test.js`
Expected: FAIL — `MakeCommand is not defined`.

- [ ] **Step 3: Написать спеки команд**

```js
/** Цель make как спека задачи. */
class MakeCommand {
    constructor({ target, dir, projectName }) {
        this.target = target;
        this.dir = dir;
        this.projectName = projectName;
        this.workspace = projectName;
        this.command = `make ${target}`;
        this.runMode = 'default';
    }

    label() {
        return `make ${this.target} (${this.projectName})`;
    }

    args() {
        return ['-C', this.dir, this.target];
    }

    spawnTarget() {
        return { command: 'make', args: this.args(), shell: false, cwd: this.dir };
    }
}

/**
 * Shell-скрипт как спека задачи. Запускаем через bash, а не сам файл: бита +x
 * может не быть, а sh не понимает bash-измов, которые в таких скриптах обычны.
 */
class ShellCommand {
    constructor({ script, dir, projectName, shellPath = 'bash' }) {
        this.script = script;
        this.dir = dir;
        this.projectName = projectName;
        this.shellPath = shellPath;
        this.workspace = projectName;
        this.command = `sh ${path.basename(script)}`;
        this.runMode = 'default';
    }

    label() {
        return `sh ${path.basename(this.script)} (${this.projectName})`;
    }

    args() {
        return [this.script];
    }

    spawnTarget() {
        return { command: this.shellPath, args: this.args(), shell: false, cwd: this.dir };
    }
}
```

- [ ] **Step 4: Научить `TaskManager` чужой рабочей папке**

В `#spawn` заменить `cwd: this.repoRoot` на `cwd: target.cwd ?? this.repoRoot`.

Добавить методы и переписать `startDocker` как обёртку:

```js
    /** Общий запуск любой спеки команды: npm, docker, make, shell. */
    startCommand(spec) {
        const task = new Task({ id: this.idFactory(), spec, ...this.taskOptions });
        task.attach(this.#spawn(spec.spawnTarget()));
        return this.#register(task);
    }

    startDocker({ label, target, service = null }) {
        return this.startCommand(new DockerCommand({ label, target, service }));
    }

    /** Запуск с настоящим терминалом: для интерактивных скриптов. */
    runTargetForeground(target) {
        const result = this.spawnSyncImpl(target.command, target.args, {
            cwd: target.cwd ?? this.repoRoot,
            stdio: 'inherit',
            shell: target.shell === true,
            windowsHide: true,
        });
        return result.status ?? 1;
    }
```

Добавить `MakeCommand` и `ShellCommand` в `module.exports`.

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 3 новых теста. Прежние тесты docker и npm не должны измениться: `cwd` для их целей не задан, значит остаётся `repoRoot`.

- [ ] **Step 6: Коммит**

```bash
git add src/task-runner.js test/projects.test.js
git commit -m "feat(projects): спеки make и shell, запуск в чужой папке"
```

---

### Task 4: `projectRunnables`

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/projects.test.js`

**Interfaces:**
- Consumes: `ProjectIndex` (Task 1), `MakefileTargets` (Task 2), `ComposeStore` (существует), `WorkspaceIndex` (существует).
- Produces: `projectRunnables(project, { composeStore = null, makefileText = null, packageScripts = [] })` → `Runnable[]`, где `Runnable` = `{ kind: 'containers'|'make'|'sh'|'npm', label, key, target?, script?, command? }`. Порядок: контейнеры, make, скрипты, npm.

- [ ] **Step 1: Написать падающий тест**

```js
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
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/projects.test.js`
Expected: FAIL — `projectRunnables is not defined`.

- [ ] **Step 3: Написать минимальную реализацию**

```js
/**
 * Плоский список запускаемого проекта, отсортированный по типу. Плоский — потому
 * что при 35 проектах главная операция «быстро найти», а её даёт фильтр по всему
 * списку, а не подменю по категориям.
 */
function projectRunnables(project, { composeStore = null, makefileText = null, packageScripts = [] } = {}) {
    const rows = [];
    if (project.composeFile) {
        const counters = composeStore?.isEnabled() ? composeStore.counters() : null;
        const suffix = counters ? ` ${counters.up}/${counters.total}` : '';
        rows.push({ kind: 'containers', key: 'containers', label: `▸    контейнеры${suffix}` });
    }
    for (const target of MakefileTargets.parse(makefileText)) {
        rows.push({ kind: 'make', key: `make:${target}`, label: `make ${target}`, target });
    }
    for (const script of project.scripts) {
        rows.push({
            kind: 'sh',
            key: `sh:${script}`,
            label: `sh   ${path.basename(script)}`,
            script,
        });
    }
    for (const command of packageScripts) {
        rows.push({ kind: 'npm', key: `npm:${command}`, label: `npm  ${command}`, command });
    }
    return rows;
}
```

Добавить `projectRunnables` в `module.exports`.

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 2 новых теста.

- [ ] **Step 5: Коммит**

```bash
git add src/task-runner.js test/projects.test.js
git commit -m "feat(projects): список запускаемого проекта"
```

---

### Task 5: `ComposeStore` по проекту

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/projects.test.js`

**Interfaces:**
- Consumes: `ComposeStore`, `ComposeProject`, `DockerCli`, `DockerRunner` (существуют).
- Produces: `ComposeRegistry` — конструктор `({ fsImpl = fs, spawnSyncImpl = spawnSync })`; методы `forProject(project): ComposeStore|null` (ленивое создание, кеш по `project.dir`), `known(): ComposeStore[]`. Событие `changed` пробрасывается наружу: `registry.on('changed', ...)` срабатывает при изменении любого созданного хранилища.

- [ ] **Step 1: Написать падающий тест**

```js
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
    assert.equal(registry.forProject({ name: 'plain', dir: '/opt/plain', composeFile: null }), null);
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
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/projects.test.js`
Expected: FAIL — `ComposeRegistry is not a constructor`.

- [ ] **Step 3: Написать минимальную реализацию**

```js
/**
 * Хранилища контейнеров по проектам. Создаются лениво: 35 проектов не должны
 * превратиться в 35 опросов docker при старте.
 */
class ComposeRegistry extends EventEmitter {
    constructor({ fsImpl = fs, spawnSyncImpl = spawnSync } = {}) {
        super();
        this.fs = fsImpl;
        this.spawnSyncImpl = spawnSyncImpl;
        this.byDir = new Map();
    }

    forProject(project) {
        if (!project?.composeFile) {
            return null;
        }
        const existing = this.byDir.get(project.dir);
        if (existing) {
            return existing;
        }
        const store = new ComposeStore({
            project: new ComposeProject({
                file: project.composeFile,
                dir: project.dir,
                name: ComposeProject.readName(project.composeFile, { fsImpl: this.fs }) ?? project.name,
            }),
            cli: new DockerCli({ composeFile: project.composeFile }),
            runner: new DockerRunner({ spawnSyncImpl: this.spawnSyncImpl }),
        });
        store.on('changed', () => this.emit('changed'));
        this.byDir.set(project.dir, store);
        return store;
    }

    known() {
        return [...this.byDir.values()];
    }
}
```

Добавить `ComposeRegistry` в `module.exports`.

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 3 новых теста.

- [ ] **Step 5: Коммит**

```bash
git add src/task-runner.js test/projects.test.js
git commit -m "feat(projects): хранилища контейнеров по проектам"
```

---

### Task 6: Секция «Проекты» и контекст `runnables`

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/ui-smoke.test.js`

**Interfaces:**
- Consumes: `ProjectIndex`, `ComposeRegistry`, `projectRunnables`, `SidePanelModel`, `HomeView`.
- Produces:
  - `TuiApp` принимает `projects = null` (экземпляр `ProjectIndex`) и `composeRegistry = null`; поля `this.projects`, `this.composeRegistry`; метод `composeForSelected(project)`.
  - `SidePanelModel` принимает `projects`; добавляет секцию `📦 Проекты (N)` со строками `kind: 'project'`, ключ `project:<dir>`. **Секция `🐳 Compose` не добавляется, если секция проектов есть.**
  - `HomeView`: состояние получает `runnables: { filter: '', selectedKey: null }`; `rightContext()` отдаёт `'runnables'` для строки проекта; методы `selectedProject()`, `visibleRunnables()`, `runnableCursor()`, `selectedRunnable()`, `moveRunnableCursor(delta)`, `renderRunnables()`, `handleRunnablesKey(chunk, key)`.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/ui-smoke.test.js`:

```js
const { ProjectIndex: Index, ComposeRegistry: Registry } = require('../src/task-runner.js');

function optTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-opt-'));
    fs.mkdirSync(path.join(root, 'crm-boss'), { recursive: true });
    fs.writeFileSync(path.join(root, 'up-all.sh'), 'echo all');
    fs.writeFileSync(path.join(root, 'crm-boss', 'docker-compose.yml'), 'name: crm-boss\n');
    fs.writeFileSync(path.join(root, 'crm-boss', 'makefile'), 'up:\n\techo up\ndown:\n\techo down\n');
    fs.writeFileSync(path.join(root, 'crm-boss', 'check.sh'), 'echo check');
    fs.writeFileSync(path.join(root, 'crm-boss', 'checkmig.sh'), 'echo mig');
    return root;
}

async function optHome(extra = {}) {
    const root = optTree();
    const projects = new Index({ root });
    projects.refresh();
    const harness = bootstrap({
        projects,
        composeRegistry: new Registry({ spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }) }),
        ...extra,
    });
    harness.home.model.rebuild();
    harness.home.model.selectKey(`project:${path.join(root, 'crm-boss')}`);
    harness.home.render();
    return { ...harness, root, projects };
}

test('секция проектов слева, запускаемое справа, по типам', async () => {
    const { home, cleanup } = await optHome();
    try {
        assert.match(home.side.content, /Проекты \(1\)/);
        assert.match(home.side.content, /crm-boss/);
        assert.equal(home.rightContext(), 'runnables');
        assert.deepEqual(
            home.visibleRunnables().map((row) => row.kind),
            ['containers', 'make', 'make', 'sh', 'sh']
        );
        assert.match(home.right.content, /контейнеры/);
        assert.match(home.right.content, /make up/);
        assert.match(home.right.content, /check\.sh/);
    } finally {
        cleanup();
    }
});

test('фильтр находит скрипт по трём буквам и ничего не запускает', async () => {
    const { app, home, press, type, cleanup } = await optHome();
    try {
        press(null, 'right');
        type('che');

        assert.deepEqual(
            home.visibleRunnables().map((row) => row.key),
            [`sh:${path.join(home.selectedProject().dir, 'check.sh')}`,
             `sh:${path.join(home.selectedProject().dir, 'checkmig.sh')}`]
        );
        assert.equal(app.manager.tasks().length, 0);
        assert.equal(app.stack.depth, 1);
    } finally {
        cleanup();
    }
});

test('состояние проекта помнится: фильтр и выбранная строка', async () => {
    const { home, press, type, cleanup } = await optHome();
    try {
        press(null, 'right');
        type('make');
        press(null, 'down');
        const chosen = home.selectedRunnable().key;

        home.model.selectKey('command:build');
        home.render();
        home.model.selectKey(`project:${home.model
            .rows()
            .find((row) => row.kind === 'project' && !row.project.isRoot).project.dir}`);
        home.render();

        assert.equal(home.runnables.filter, 'make');
        assert.equal(home.selectedRunnable().key, chosen);
    } finally {
        cleanup();
    }
});

test('при секции проектов отдельной секции Compose нет', async () => {
    const { home, cleanup } = await optHome();
    try {
        assert.equal(home.side.content.includes('🐳 Compose'), false);
    } finally {
        cleanup();
    }
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/ui-smoke.test.js`
Expected: FAIL — `bootstrap` не знает `projects`, `home.runnables` не определён.

- [ ] **Step 3: Провести проекты через приложение**

В `TuiApp.constructor` добавить параметры `projects = null, composeRegistry = null` и поля:

```js
        this.projects = projects ?? new ProjectIndex({ root: repoRoot });
        if (!projects) {
            this.projects.refresh();
        }
        this.composeRegistry =
            composeRegistry ?? new ComposeRegistry({ spawnSyncImpl: spawnSync });
```

В `TuiApp.run` подписаться на реестр так же, как на `compose`:

```js
        this.composeRegistry.on('changed', () => {
            const view = this.stack.top();
            if (view instanceof HomeView) {
                view.model.rebuild();
                view.render();
            }
            this.render();
        });
```

В `SidePanelModel.constructor` добавить `projects = null`; в `rebuild()` вызвать `this.#pushProjectRows(rows)` перед `#pushComposeRows(rows)`, а сам `#pushComposeRows` начать с проверки:

```js
    #pushComposeRows(rows) {
        const store = this.compose;
        // Когда есть секция проектов, корень уже в ней первой строкой: две секции
        // про один compose означали бы два пути с раздельным состоянием.
        if (this.projects?.hasChildren() || !store?.isEnabled()) {
            return;
        }
```

и добавить:

```js
    #pushProjectRows(rows) {
        const index = this.projects;
        if (!index?.hasChildren()) {
            return;
        }
        const projects = index.projects();
        rows.push({
            kind: 'header',
            key: 'header:projects',
            label: `📦 Проекты (${projects.filter((project) => !project.isRoot).length})`,
            selectable: false,
        });
        for (const project of projects) {
            rows.push({
                kind: 'project',
                key: `project:${project.dir}`,
                label: `  ${project.name}`,
                selectable: true,
                project,
            });
        }
    }
```

В `HomeView.constructor` передать `projects: app.projects` в `SidePanelModel`.

- [ ] **Step 4: Реализовать правую колонку**

В `freshState` добавить `runnables: { filter: '', selectedKey: null }`, в `syncActiveKey`/`captureState` — проброс `runnables`.

В `rightContext()` добавить ветку:

```js
        if (kind === 'project') {
            return this.runnablesContext;
        }
```

где `this.runnablesContext` — поле состояния со значением `'runnables'` или `'containers'` (переключается входом в контейнеры и `Esc`). Добавить его в `freshState` со значением `'runnables'`.

Добавить методы:

```js
    selectedProject() {
        const row = this.model.selected();
        return row?.kind === 'project' ? row.project : null;
    }

    projectComposeStore() {
        const project = this.selectedProject();
        return project ? this.app.composeRegistry.forProject(project) : null;
    }

    allRunnables() {
        const project = this.selectedProject();
        if (!project) {
            return [];
        }
        return projectRunnables(project, {
            composeStore: this.projectComposeStore(),
            makefileText: project.makefile ? this.app.readTextFile(project.makefile) : null,
            packageScripts: project.hasPackageJson
                ? Object.keys(readJsonFile(path.join(project.dir, 'package.json'))?.scripts ?? {})
                      .sort((a, b) => a.localeCompare(b))
                : [],
        });
    }

    visibleRunnables() {
        const needle = this.runnables.filter.toLowerCase();
        return this.allRunnables().filter((row) => row.label.toLowerCase().includes(needle));
    }

    runnableCursor() {
        const rows = this.visibleRunnables();
        const found = rows.findIndex((row) => row.key === this.runnables.selectedKey);
        return found >= 0 ? found : 0;
    }

    selectedRunnable() {
        return this.visibleRunnables()[this.runnableCursor()] ?? null;
    }

    moveRunnableCursor(delta) {
        const rows = this.visibleRunnables();
        if (rows.length === 0) {
            return;
        }
        const next = Math.max(0, Math.min(rows.length - 1, this.runnableCursor() + delta));
        this.runnables.selectedKey = rows[next].key;
    }

    renderRunnables() {
        const project = this.selectedProject();
        const rows = this.visibleRunnables();
        const cursor = this.runnableCursor();
        const filter = this.runnables.filter ? `/${this.runnables.filter}` : 'без фильтра';
        this.right.setLabel(` ${project.name} • ${project.dir} • ${filter} • ${rows.length} `);
        const body =
            rows.length === 0
                ? '{grey-fg}Ничего не найдено.{/}'
                : rows
                      .map((row, position) =>
                          position === cursor && this.focus === 'right'
                              ? `{inverse}${stripTags(row.label)}{/}`
                              : row.label
                      )
                      .join('\n');
        this.right.setContent(body);
        if (this.focus === 'right') {
            this.right.scrollTo(cursor);
        }
    }

    handleRunnablesKey(chunk, key) {
        const name = key?.name;
        if (name === 'up' || name === 'down') {
            this.moveRunnableCursor(name === 'down' ? 1 : -1);
            this.render();
            return true;
        }
        if (CONFIRM_KEYS.has(name)) {
            const row = this.selectedRunnable();
            if (row) {
                this.openRunnable(row);
            }
            return true;
        }
        if (name === 'backspace') {
            if (this.runnables.filter.length === 0) {
                return false;
            }
            this.runnables.filter = this.runnables.filter.slice(0, -1);
            this.render();
            return true;
        }
        if (
            !key?.ctrl &&
            !key?.meta &&
            typeof chunk === 'string' &&
            chunk.length === 1 &&
            chunk >= ' '
        ) {
            this.runnables.filter += chunk;
            this.render();
            return true;
        }
        return false;
    }
```

Заглушка `openRunnable` (полная реализация — Task 7):

```js
    openRunnable(row) {
        this.app.notify(`Меню запуска появится в следующей задаче: ${row.label}`);
    }
```

В `renderRight()` добавить ветку `runnables` → `renderRunnables()`, в `handleKey` — вызов `handleRunnablesKey` при `focus === 'right'` и контексте `runnables`, в `hotkeys()` — строку подсказки `печатай фильтр  ↑↓ выбор  Enter действия  Tab/←/Esc назад`.

Добавить в `TuiApp` чтение файла (нужно для makefile, отдельным методом ради инжекции в тестах):

```js
    readTextFile(file) {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch {
            return null;
        }
    }
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 4 новых теста.

- [ ] **Step 6: Коммит**

```bash
git add src/task-runner.js test/ui-smoke.test.js
git commit -m "feat(projects): секция проектов и список запускаемого"
```

---

### Task 7: Меню запуска, подтверждение, задачи

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/ui-smoke.test.js`

**Interfaces:**
- Consumes: `MenuView`, `ConfirmView`, `TuiApp.confirmCommands` (существуют), `MakeCommand`, `ShellCommand`, `NpmCommand`, `TaskManager.startCommand`, `TaskManager.runTargetForeground`.
- Produces:
  - `HomeView.openRunnable(row)` — полная реализация: контейнеры уводят в свой контекст, остальное открывает `MenuView` с пунктами `run` и `run-foreground`.
  - `TuiApp.runRunnable({ project, row, foreground })` — собирает спеку, спрашивает подтверждение, запускает задачу или сворачивает TUI.
  - `specForRunnable({ project, row })` → спека команды (`MakeCommand`, `ShellCommand` или `NpmCommand`).

- [ ] **Step 1: Написать падающий тест**

```js
test('Enter на скрипте открывает меню из двух пунктов', async () => {
    const { app, home, press, pressEnter, cleanup } = await optHome();
    try {
        press(null, 'right');
        home.runnables.selectedKey = `sh:${path.join(home.selectedProject().dir, 'check.sh')}`;
        home.render();

        pressEnter();

        assert.equal(app.stack.depth, 2);
        assert.match(app.stack.top().title, /check\.sh/);
        assert.deepEqual(
            app.stack.top().items.map((item) => item.value),
            ['run', 'run-foreground']
        );
        assert.equal(app.manager.tasks().length, 0);
    } finally {
        cleanup();
    }
});

test('запуск скрипта задачей: подтверждение с командой и папкой', async () => {
    const { app, home, press, pressEnter, cleanup } = await optHome();
    try {
        press(null, 'right');
        home.runnables.selectedKey = `sh:${path.join(home.selectedProject().dir, 'check.sh')}`;
        home.render();
        pressEnter();
        pressEnter();

        assert.ok(app.stack.top() instanceof ConfirmView);
        assert.match(app.stack.top().text, /bash .*check\.sh/);
        assert.match(app.stack.top().text, /рабочая папка/);
        assert.equal(app.manager.tasks().length, 0);

        press(null, 'y');
        const task = app.manager.tasks()[0];
        assert.match(task.spec.label(), /sh check\.sh \(crm-boss\)/);
        assert.equal(task.spec.spawnTarget().cwd, home.selectedProject().dir);
    } finally {
        cleanup();
    }
});

test('цель make запускается с -C рабочей папки', async () => {
    const { app, home, press, pressEnter, cleanup } = await optHome();
    try {
        press(null, 'right');
        home.runnables.selectedKey = 'make:up';
        home.render();
        pressEnter();
        pressEnter();
        press(null, 'y');

        const task = app.manager.tasks()[0];
        assert.deepEqual(task.spec.spawnTarget().args, ['-C', home.selectedProject().dir, 'up']);
    } finally {
        cleanup();
    }
});

test('запуск в терминале сворачивает screen и ничего не добавляет в задачи', async () => {
    const { app, home, screen, press, pressEnter, cleanup } = await optHome();
    try {
        press(null, 'right');
        home.runnables.selectedKey = `sh:${path.join(home.selectedProject().dir, 'check.sh')}`;
        home.render();
        pressEnter();
        press(null, 'down');
        pressEnter();
        press(null, 'y');

        assert.ok(screen.left && screen.entered, 'screen снят и восстановлен');
        assert.equal(app.manager.tasks().length, 0, 'foreground не создаёт задачу');
    } finally {
        cleanup();
    }
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/ui-smoke.test.js`
Expected: FAIL — меню не открывается, всплывает заглушка `notify`.

- [ ] **Step 3: Реализовать спеку по строке**

```js
function specForRunnable({ project, row, platform = process.platform }) {
    if (row.kind === 'make') {
        return new MakeCommand({ target: row.target, dir: project.dir, projectName: project.name });
    }
    if (row.kind === 'sh') {
        return new ShellCommand({ script: row.script, dir: project.dir, projectName: project.name });
    }
    if (row.kind === 'npm') {
        // Проект чужой: запускаем в его папке без --workspace.
        const spec = new NpmCommand({ command: row.command, workspace: '.', platform });
        spec.dir = project.dir;
        const target = spec.spawnTarget();
        return {
            command: `npm ${row.command}`,
            workspace: project.name,
            runMode: 'default',
            label: () => `npm ${row.command} (${project.name})`,
            args: () => spec.args(),
            spawnTarget: () => ({ ...target, cwd: project.dir }),
        };
    }
    return null;
}
```

- [ ] **Step 4: Реализовать меню и запуск**

Заменить заглушку `HomeView.openRunnable`:

```js
    openRunnable(row) {
        if (row.kind === 'containers') {
            // Переход в контейнеры включается в Task 8: до неё правая колонка читала
            // бы одиночный compose вместо compose выбранного проекта.
            this.app.notify('Список контейнеров проекта появится в следующей задаче.');
            return;
        }
        this.app.push(
            new MenuView(this.app, {
                title: row.label.trim(),
                hint: '↑↓ выбор  Enter выполнить  Backspace назад',
                items: [
                    { label: 'Запустить (задачей, с логом)', value: 'run' },
                    { label: 'Запустить в терминале', value: 'run-foreground' },
                ],
                onPick: (action) => {
                    this.app.pop();
                    this.app.runRunnable({
                        project: this.selectedProject(),
                        row,
                        foreground: action === 'run-foreground',
                    });
                },
            })
        );
    }
```

Добавить в `TuiApp`:

```js
    runRunnable({ project, row, foreground }) {
        const spec = specForRunnable({ project, row });
        if (!spec) {
            return;
        }
        const target = spec.spawnTarget();
        this.confirmCommands({
            title: `${foreground ? 'Запустить в терминале' : 'Запустить'} ${row.label.trim()}`,
            targets: [target],
            note: `рабочая папка: ${target.cwd ?? project.dir}`,
            onConfirm: () => {
                if (foreground) {
                    this.suspend(() => {
                        const status = this.manager.runTargetForeground(target);
                        process.stdout.write(`\nЗавершилось с кодом ${status}.\n`);
                        return status;
                    });
                    return;
                }
                this.manager.startCommand(spec);
            },
        });
    }
```

В `HomeView` добавить возврат из контейнеров: в `handleContainersKey` (или в `handleKey` перед ним) обработать `escape`/`left`, когда `runnablesContext === 'containers'`:

```js
        if (this.runnablesContext === 'containers' && (name === 'escape' || name === 'left')) {
            this.runnablesContext = 'runnables';
            this.render();
            return true;
        }
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 4 новых теста.

- [ ] **Step 6: Коммит**

```bash
git add src/task-runner.js test/ui-smoke.test.js
git commit -m "feat(projects): меню запуска, подтверждение и задачи"
```

---

### Task 8: Контейнеры выбранного проекта

**Files:**
- Modify: `src/task-runner.js`
- Modify: `test/ui-smoke.test.js`

**Interfaces:**
- Consumes: `ComposeRegistry` (Task 5), существующие `renderContainers`, `handleContainersKey`, `composeAction`.
- Produces: `HomeView.activeComposeStore()` → хранилище выбранного проекта либо одиночное `app.compose`; все места, где раньше читался `this.app.compose`, читают его.

- [ ] **Step 1: Написать падающий тест**

```js
test('строка контейнеров уводит в список контейнеров проекта и Esc возвращает', async () => {
    const { app, home, press, pressEnter, cleanup } = await optHome();
    try {
        press(null, 'right');
        home.runnables.selectedKey = 'containers';
        home.render();

        pressEnter();
        assert.equal(home.rightContext(), 'containers');
        assert.match(home.right.label, /crm-boss/);

        press(null, 'escape');
        assert.equal(home.rightContext(), 'runnables');
        assert.match(home.right.content, /make up/);
        assert.equal(app.stack.depth, 1, 'без модалок');
    } finally {
        cleanup();
    }
});

test('действия с контейнером идут в docker выбранного проекта', async () => {
    const { app, home, press, pressEnter, cleanup } = await optHome({
        composeRegistry: new Registry({
            spawnSyncImpl: () => ({
                status: 0,
                stdout: '{"Service":"api","Name":"api-1","State":"running","Status":"Up","Image":"repo/app:api"}',
                stderr: '',
            }),
        }),
    });
    try {
        press(null, 'right');
        home.runnables.selectedKey = 'containers';
        home.render();
        pressEnter();
        await home.activeComposeStore().refresh();
        home.render();
        press(null, 'down');
        pressEnter();
        press(null, 'down');
        pressEnter();

        assert.ok(app.stack.top() instanceof ConfirmView);
        assert.match(app.stack.top().text, /crm-boss[/\\]docker-compose\.yml/);
        press(null, 'y');

        const task = app.manager.tasks()[0];
        assert.match(task.spec.label(), /обновить api/);
    } finally {
        cleanup();
    }
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/ui-smoke.test.js`
Expected: FAIL — `home.activeComposeStore is not a function`.

- [ ] **Step 3: Реализовать выбор активного хранилища**

В `HomeView` добавить:

```js
    /**
     * Контейнеры показываются либо для выбранного проекта, либо для одиночного
     * compose рядом с раннером — в зависимости от того, откуда пришёл курсор.
     */
    activeComposeStore() {
        return this.projectComposeStore() ?? this.app.compose;
    }
```

Заменить обращения `this.app.compose` внутри `visibleContainers`, `renderContainers`, `containerLine` на `this.activeComposeStore()`.

В `TuiApp.composeAction`, `openImageCatalog`, `confirmRollback` заменить `this.compose` на активное хранилище: добавить в `TuiApp` метод

```js
    activeCompose() {
        const view = this.stack.views.find((candidate) => candidate instanceof HomeView);
        return view?.activeComposeStore() ?? this.compose;
    }
```

и использовать его вместо `this.compose` в этих трёх методах. `ImageCatalog` собирать от активного хранилища:

```js
        const store = this.activeCompose();
        const catalog =
            this.imageCatalog ?? new ImageCatalog({ cli: store.cli, runner: store.runner });
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS, плюс 2 новых теста.

- [ ] **Step 5: Коммит**

```bash
git add src/task-runner.js test/ui-smoke.test.js
git commit -m "feat(projects): контейнеры выбранного проекта"
```

---

### Task 9: Опрос, `r`, справка, README, версия

**Files:**
- Modify: `src/task-runner.js`
- Modify: `README.md`
- Modify: `test/ui-smoke.test.js`
- Modify: `package.json` (через `npm version minor`)

**Interfaces:**
- Consumes: всё из Tasks 1–8.
- Produces: опрос `ps` только для проекта под курсором, `r` пересканирует проекты и перечитывает `ps`, пункты в `HelpView`, раздел в README, версия 0.4.0 с тегом.

- [ ] **Step 1: Написать падающий тест**

```js
test('опрашивается только тот проект, на котором курсор', async () => {
    const { app, home, cleanup } = await optHome({ tickMs: 1000 });
    try {
        const store = home.activeComposeStore();
        let refreshes = 0;
        store.refresh = async () => {
            refreshes += 1;
        };

        for (let tick = 0; tick < 5; tick += 1) {
            app.onTick();
        }
        assert.equal(refreshes, 1, 'один опрос за 5 секунд');

        home.model.selectKey('command:build');
        home.render();
        for (let tick = 0; tick < 5; tick += 1) {
            app.onTick();
        }
        assert.equal(refreshes, 1, 'ушли с проекта — опрос прекратился');
    } finally {
        cleanup();
    }
});

test('r пересканирует проекты', async () => {
    const { home, root, press, cleanup } = await optHome();
    try {
        fs.writeFileSync(path.join(root, 'crm-boss', 'newone.sh'), 'echo new');

        press('r', 'r');

        assert.ok(
            home.allRunnables().some((row) => row.label.includes('newone.sh')),
            'новый скрипт появился без перезапуска'
        );
    } finally {
        cleanup();
    }
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что падает**

Run: `node --test test/ui-smoke.test.js`
Expected: FAIL — опрос идёт не для того хранилища, `r` не пересканирует проекты.

- [ ] **Step 3: Поправить тик и `r`**

В `TuiApp.onTick` заменить ветку опроса контейнеров на:

```js
        // Контейнеры — раз в 5 с и только для того, на чём стоит курсор: 35
        // проектов не должны превратиться в 35 опросов docker.
        if (this.ticks % every(5000) === 0) {
            const view = this.stack.top();
            if (view instanceof HomeView) {
                const kind = view.model.selected()?.kind;
                if (kind === 'compose' || kind === 'project') {
                    const store = view.activeComposeStore();
                    if (store?.isEnabled()) {
                        void store.refresh();
                    }
                }
            }
        }
```

В `HomeView.handleKey`, в ветке `name === 'r'`, добавить пересканирование проектов:

```js
            this.app.projects?.refresh();
```

- [ ] **Step 4: Дополнить справку**

В `HelpView` добавить строки:

```js
                '',
                'Каталог проектов:',
                '  курсор на проекте — справа его make-цели, скрипты, npm и контейнеры',
                '  Enter — меню: запустить задачей или в терминале (для интерактивных)',
                '  r — пересканировать проекты и перечитать состояние контейнеров',
```

- [ ] **Step 5: Дополнить README**

Добавить раздел перед «Docker Compose»:

```markdown
## Каталог проектов

Если в текущей папке лежат несколько проектов — как `/opt` на сервере, — слева
появляется секция `📦 Проекты`: первая строка сам корень, дальше подпапки, в которых
есть compose-файл, makefile, `*.sh` или `package.json` со скриптами. Курсор на проекте
— справа плоский список запускаемого, отсортированный по типу:

```
▸    контейнеры 12/14
make up
make down
sh   check.sh
sh   checkmig.sh
npm  build
```

Буквы фильтруют весь список сразу: `che` находит `check.sh` и `checkmig.sh`. `Enter`
на строке контейнеров уводит в список контейнеров этого проекта, `Esc` возвращает.
`Enter` на make, скрипте или npm открывает меню:

- **Запустить (задачей, с логом)** — обычная задача: лог рядом, поиск по `/`, стоп по
  `s` с убийством дерева процессов.
- **Запустить в терминале** — TUI сворачивается, команда получает настоящий терминал.
  Нужно для всего интерактивного: задачи идут со `stdin: ignore`, и скрипт с вопросом
  `Continue? [y/N]` в задаче просто повиснет.

Перед запуском показывается точная команда и рабочая папка, и спрашивается
подтверждение — всегда, без списка «безопасных» имён.

Сканируется **один уровень** вниз: рекурсия по `/opt` уперлась бы в тома docker и
логи. Цели make читаются из файла, `make -qp` не вызывается. Скрипты запускаются как
`bash <файл>`: бита `+x` может не быть, а `sh` не понимает bash-измов.

Состояние контейнеров опрашивается только для проекта под курсором — 35 проектов не
превращаются в 35 вызовов `docker compose ps`. `r` пересканирует проект и перечитает
состояние.
```

- [ ] **Step 6: Прогнать всё и поднять версию**

Run: `npm test`
Expected: PASS.

Run: `node bin/packer-commander.js --self-check`
Expected: код 0.

Run: `npm version minor -m "chore: версия %s"`
Expected: `v0.4.0`.

- [ ] **Step 7: Коммит и пуш**

```bash
git add -A
git commit -m "feat(projects): опрос по курсору, r, справка и README"
git push origin main --follow-tags
```

---

## Соответствие спеке

| Требование спеки | Задача |
|---|---|
| `ProjectIndex`: один уровень, корень, четыре сорта запускаемого | 1 |
| Пропуск пустых, `node_modules`, скрытых, папок без прав | 1 |
| `MakefileTargets.parse` без вызова `make -qp` | 2 |
| `MakeCommand`, `ShellCommand` через `bash`, рабочая папка проекта | 3 |
| Запуск задачей и запуск в терминале | 3, 7 |
| `projectRunnables`: плоский список, порядок типов | 4 |
| `ComposeStore` по проекту, ленивое создание | 5 |
| Секция `📦 Проекты`, отсутствие дублирующей секции `Compose` | 6 |
| Контекст `runnables`, фильтр буквами, состояние по проекту | 6 |
| Меню из двух пунктов, подтверждение с командой и папкой | 7 |
| Строка контейнеров → контекст `containers`, `Esc` назад | 7, 8 |
| Действия с контейнерами идут в docker выбранного проекта | 8 |
| Опрос только выбранного проекта, `r` пересканирует | 9 |
| Справка и README | 9 |
