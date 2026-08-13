#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const LOG_LIMIT = 10000;
const KILL_TIMEOUT_MS = 5000;
const MIN_COLUMNS = 80;
const MIN_ROWS = 24;
const TICK_MS = 500;
const SIDE_WIDTH = 34;

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
            if (
                !entry.isDirectory() ||
                entry.name.startsWith('.') ||
                SKIPPED_DIRS.has(entry.name)
            ) {
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
        const pkg = files.has('package.json')
            ? readJsonFile(path.join(dir, 'package.json'), this.fs)
            : null;
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

/**
 * Плоский список запускаемого проекта, отсортированный по типу. Плоский — потому
 * что при 35 проектах главная операция «быстро найти», а её даёт фильтр по всему
 * списку, а не подменю по категориям.
 */
function projectRunnables(
    project,
    { composeStore = null, makefileText = null, packageScripts = [] } = {}
) {
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

const DOCKER_DATE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})/;

/**
 * docker печатает дату как "2026-08-12 21:04:11 +0300 MSK" — с пробелом вместо T,
 * смещением без двоеточия и названием зоны на хвосте. new Date() на такое отдаёт
 * Invalid Date, поэтому приводим к ISO сами. ISO-строки (из реестра) проходят как есть.
 */
function parseDockerDate(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return null;
    }
    const match = text.match(DOCKER_DATE);
    const parsed = match
        ? new Date(`${match[1]}T${match[2]}${match[3]}:${match[4]}`)
        : new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseImagesOutput(text) {
    return parseJsonRecords(text)
        .map((record) => {
            const digest = String(pickField(record, 'Digest', 'digest') ?? '');
            const tag = String(pickField(record, 'Tag', 'tag') ?? '');
            const createdAt = parseDockerDate(pickField(record, 'CreatedAt', 'createdAt'));
            return {
                repository: String(pickField(record, 'Repository', 'repository') ?? ''),
                tag: tag && tag !== '<none>' ? tag : null,
                digest,
                createdAt,
                size: String(pickField(record, 'Size', 'size') ?? ''),
                id: String(pickField(record, 'ID', 'Id', 'id') ?? ''),
            };
        })
        .filter((image) => image.digest && image.digest !== '<none>');
}

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
                name:
                    ComposeProject.readName(project.composeFile, { fsImpl: this.fs }) ??
                    project.name,
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

function readJsonFile(filePath, fsImpl = fs) {
    try {
        const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Ищет корень проекта, поднимаясь от стартовой папки. Монорепо с "workspaces"
 * важнее ближайшего package.json: запуск из apps/api должен видеть весь репозиторий.
 * Дальше .git не уходим.
 */
function findProjectRoot(startDir, { fsImpl = fs } = {}) {
    let dir = path.resolve(startDir);
    let nearestPackage = null;
    for (;;) {
        const pkg = readJsonFile(path.join(dir, 'package.json'), fsImpl);
        if (pkg) {
            if (pkg.workspaces) {
                return dir;
            }
            if (!nearestPackage) {
                nearestPackage = dir;
            }
        }
        if (fsImpl.existsSync(path.join(dir, '.git'))) {
            return nearestPackage ?? dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return nearestPackage ?? path.resolve(startDir);
        }
        dir = parent;
    }
}

const FALLBACK_ROOTS = ['apps', 'libs', 'packages', 'services'];

/**
 * Папки для сканирования: статические головы globs из "workspaces"
 * ("apps/*" → "apps"). Нет workspaces — пробуем привычные имена, а если и их нет,
 * сканируем сам корень.
 */
function workspaceRoots(repoRoot, { fsImpl = fs } = {}) {
    const pkg = readJsonFile(path.join(repoRoot, 'package.json'), fsImpl);
    const globs = Array.isArray(pkg?.workspaces)
        ? pkg.workspaces
        : Array.isArray(pkg?.workspaces?.packages)
          ? pkg.workspaces.packages
          : [];
    const roots = new Set();
    for (const glob of globs) {
        const head = String(glob)
            .split('/')
            .find((part) => part && !part.includes('*'));
        roots.add(head ?? '.');
    }
    if (roots.size === 0) {
        for (const candidate of FALLBACK_ROOTS) {
            if (fsImpl.existsSync(path.join(repoRoot, candidate))) {
                roots.add(candidate);
            }
        }
    }
    if (roots.size === 0) {
        roots.add('.');
    }
    return [...roots];
}

/**
 * Реестр воркспейсов: какие пакеты есть и какие в них npm-скрипты.
 * Диск читается только в refresh(), всё остальное — из памяти.
 */
class WorkspaceIndex {
    constructor({ repoRoot, roots = ['apps', 'libs'], fsImpl = fs, now = () => Date.now() }) {
        this.repoRoot = repoRoot;
        this.roots = roots;
        this.fs = fsImpl;
        this.now = now;
        /** @type {{name: string, rel: string, scripts: string[]}[]} */
        this.items = [];
        /** @type {Map<string, number>} */
        this.lastUsedAt = new Map();
    }

    refresh() {
        const found = [];
        for (const root of this.roots) {
            const absRoot = path.join(this.repoRoot, root);
            if (!this.#isDirectory(absRoot)) {
                continue;
            }
            const stack = [absRoot];
            while (stack.length > 0) {
                const dir = stack.pop();
                const pkg = this.#readPackage(path.join(dir, 'package.json'));
                if (pkg) {
                    const scripts = Object.keys(pkg.scripts || {}).sort((a, b) =>
                        a.localeCompare(b)
                    );
                    if (scripts.length > 0) {
                        const relative = path.relative(this.repoRoot, dir).split(path.sep).join('/');
                        // Корневой package.json — это тоже воркспейс, но без --workspace.
                        const rel = relative === '' ? '.' : relative;
                        found.push({
                            name: typeof pkg.name === 'string' && pkg.name ? pkg.name : rel,
                            rel,
                            scripts,
                        });
                    }
                }
                for (const entry of this.fs.readdirSync(dir, { withFileTypes: true })) {
                    if (!entry.isDirectory()) {
                        continue;
                    }
                    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
                        continue;
                    }
                    stack.push(path.join(dir, entry.name));
                }
            }
        }
        this.items = found.sort((a, b) => a.rel.localeCompare(b.rel));
    }

    packages() {
        return this.items;
    }

    commands() {
        const unique = [...new Set(this.items.flatMap((pkg) => pkg.scripts))];
        return unique.sort((a, b) => {
            const usedA = this.lastUsedAt.get(a) ?? 0;
            const usedB = this.lastUsedAt.get(b) ?? 0;
            if (usedA !== usedB) {
                return usedB - usedA;
            }
            return a.localeCompare(b);
        });
    }

    packagesWithCommand(command) {
        return this.items.filter((pkg) => pkg.scripts.includes(command));
    }

    markCommandUsed(command) {
        if (command) {
            this.lastUsedAt.set(command, this.now());
        }
    }

    #isDirectory(target) {
        try {
            return this.fs.statSync(target).isDirectory();
        } catch {
            return false;
        }
    }

    #readPackage(filePath) {
        try {
            const parsed = JSON.parse(this.fs.readFileSync(filePath, 'utf8'));
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }
}

/** Знает, как собрать `npm run ...` и чем его спавнить на текущей платформе. */
class NpmCommand {
    constructor({
        command,
        workspace,
        runMode = 'default',
        platform = process.platform,
        nodePath = process.execPath,
        npmExecPath = process.env.npm_execpath,
        exists = (target) => fs.existsSync(target),
    }) {
        this.command = command;
        this.workspace = workspace;
        this.runMode = runMode === 'watch' ? 'watch' : 'default';
        this.platform = platform;
        this.nodePath = nodePath;
        this.npmExecPath = typeof npmExecPath === 'string' ? npmExecPath : '';
        this.exists = exists;
    }

    isRootWorkspace() {
        return !this.workspace || this.workspace === '.';
    }

    args() {
        // Корневой пакет запускается без --workspace: npm такого значения не понимает.
        const args = this.isRootWorkspace()
            ? ['run', this.command]
            : ['run', this.command, '--workspace', this.workspace];
        if (this.runMode === 'watch') {
            args.push('--', '--watch');
        }
        return args;
    }

    /**
     * Чем запускать npm. Порядок важен именно на Windows: Node с 20.12 отказывается
     * спавнить .cmd без shell (EINVAL), поэтому сначала ищем js-точку входа npm и
     * запускаем её тем же node, и только в последнюю очередь зовём npm.cmd — уже
     * через shell.
     */
    spawnTarget() {
        const args = this.args();
        if (this.npmExecPath && this.exists(this.npmExecPath)) {
            return { command: this.nodePath, args: [this.npmExecPath, ...args], shell: false };
        }
        const bundled = path.join(
            path.dirname(this.nodePath),
            'node_modules',
            'npm',
            'bin',
            'npm-cli.js'
        );
        if (this.exists(bundled)) {
            return { command: this.nodePath, args: [bundled, ...args], shell: false };
        }
        if (this.platform === 'win32') {
            return { command: 'npm.cmd', args, shell: true };
        }
        return { command: 'npm', args, shell: false };
    }

    label() {
        const suffix = this.runMode === 'watch' ? ' --watch' : '';
        return `${this.workspace} :: ${this.command}${suffix}`;
    }
}

const ANSI_SGR = /\x1b\[([0-9;]*)m/g;
const ANSI_OTHER = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07?|\x1b[()][A-Za-z0-9]/g;
const SGR_RESET_CODES = new Set(['0', '22', '39', '49']);
const SGR_TO_TAG = new Map([
    ['1', '{bold}'],
    ['4', '{underline}'],
    ['30', '{black-fg}'],
    ['31', '{red-fg}'],
    ['32', '{green-fg}'],
    ['33', '{yellow-fg}'],
    ['34', '{blue-fg}'],
    ['35', '{magenta-fg}'],
    ['36', '{cyan-fg}'],
    ['37', '{white-fg}'],
    ['90', '{gray-fg}'],
    ['91', '{red-fg}'],
    ['92', '{green-fg}'],
    ['93', '{yellow-fg}'],
    ['94', '{blue-fg}'],
    ['95', '{magenta-fg}'],
    ['96', '{cyan-fg}'],
    ['97', '{white-fg}'],
]);

/**
 * Перевод ANSI-вывода дочернего процесса в теги blessed.
 * Сырой ANSI внутри виджета уезжает мимо рамок, а tags:true без предобработки
 * ломается на квадратных скобках из вывода — поэтому режем по SGR и экранируем
 * только текстовые сегменты.
 */
class AnsiTags {
    static convert(text) {
        const source = String(text ?? '');
        let result = '';
        let cursor = 0;
        ANSI_SGR.lastIndex = 0;
        let match = ANSI_SGR.exec(source);
        while (match) {
            result += AnsiTags.clean(source.slice(cursor, match.index));
            result += AnsiTags.tagsFor(match[1]);
            cursor = match.index + match[0].length;
            match = ANSI_SGR.exec(source);
        }
        return result + AnsiTags.clean(source.slice(cursor));
    }

    /**
     * Чистит текстовый сегмент между SGR-последовательностями. Порядок важен:
     * ANSI_OTHER матчит и SGR (терминатор "m" входит в [A-Za-z]), поэтому его
     * нельзя применять до разбора цветов.
     */
    static clean(text) {
        return AnsiTags.escape(text.replace(ANSI_OTHER, ''));
    }

    static escape(text) {
        // Один проход: две последовательные замены испортили бы "}" внутри
        // только что вставленного "{open}".
        return text.replace(/[{}]/g, (char) => (char === '{' ? '{open}' : '{close}'));
    }

    static tagsFor(codes) {
        const parts = String(codes || '0')
            .split(';')
            .filter((part) => part.length > 0);
        if (parts.length === 0) {
            return '{/}';
        }
        return parts
            .map((code) => {
                if (SGR_RESET_CODES.has(code)) {
                    return '{/}';
                }
                return SGR_TO_TAG.get(code) ?? '';
            })
            .join('');
    }
}

/** Кольцевой буфер строк лога с раздельным таймстемпом и поиском. */
/**
 * Обратная операция к AnsiTags: теги blessed убираем, экранированные скобки
 * возвращаем как есть. Нужно для копирования в буфер обмена — там нужен текст,
 * а не разметка.
 */
function stripTags(text) {
    // Один проход: разделители-заглушки не нужны, а значит и управляющих байтов
    // в исходнике не будет.
    return String(text ?? '').replace(/{open}|{close}|{[^{}]*}/g, (match) => {
        if (match === '{open}') {
            return '{';
        }
        if (match === '{close}') {
            return '}';
        }
        return '';
    });
}


/** Текст буфера для копирования: без тегов, по желанию с таймстемпами. */
function bufferToText(buffer, { withTimestamps = false } = {}) {
    const lines = buffer?.lines() ?? [];
    return lines
        .map((line) => {
            const stamp = withTimestamps ? `${line.ts.toISOString().slice(11, 19)} ` : '';
            return `${stamp}${stripTags(line.text)}`;
        })
        .join('\n');
}

const CLIPBOARD_TOOLS = {
    win32: { command: 'clip', args: [] },
    darwin: { command: 'pbcopy', args: [] },
    linux: { command: 'xclip', args: ['-selection', 'clipboard'] },
};

/**
 * Копирование без мыши. Сначала системная утилита, потом OSC 52 — он проходит
 * даже через ssh и понимается VS Code и Windows Terminal.
 */
function copyToClipboard(
    text,
    { platform = process.platform, spawnSyncImpl = spawnSync, stdout = process.stdout } = {}
) {
    const tool = CLIPBOARD_TOOLS[platform];
    if (tool) {
        try {
            const result = spawnSyncImpl(tool.command, tool.args, {
                input: text,
                windowsHide: true,
            });
            if (result && !result.error && (result.status === 0 || result.status === null)) {
                return 'системный буфер';
            }
        } catch {
            // утилиты нет — уходим на OSC 52
        }
    }
    try {
        const payload = Buffer.from(text, 'utf8').toString('base64');
        stdout.write(`\x1b]52;c;${payload}\x07`);
        return 'терминал (OSC 52)';
    } catch {
        return null;
    }
}

class LogBuffer {
    constructor({ limit = LOG_LIMIT, now = () => new Date() } = {}) {
        this.limit = limit;
        this.now = now;
        /** @type {{ts: Date, stream: string, text: string}[]} */
        this.entries = [];
        this.pending = '';
        this.pendingStream = 'stdout';
    }

    get size() {
        return this.entries.length;
    }

    append(chunk, stream = 'stdout') {
        const text = String(chunk ?? '').replace(/\r\n/g, '\n');
        if (!text) {
            return [];
        }
        this.pendingStream = stream;
        const added = [];
        for (const char of text) {
            if (char === '\n') {
                added.push(this.#push(this.pending, stream));
                this.pending = '';
                continue;
            }
            if (char === '\r') {
                // прогресс-бар перезаписывает текущую строку, а не плодит новые
                this.pending = '';
                continue;
            }
            this.pending += char;
        }
        return added;
    }

    flush() {
        if (this.pending.length === 0) {
            return [];
        }
        const entry = this.#push(this.pending, this.pendingStream);
        this.pending = '';
        return [entry];
    }

    lines() {
        return this.entries;
    }

    search(pattern) {
        const needle = String(pattern || '').toLowerCase();
        if (!needle) {
            return [];
        }
        const found = [];
        for (let index = 0; index < this.entries.length; index += 1) {
            if (this.entries[index].text.toLowerCase().includes(needle)) {
                found.push(index);
            }
        }
        return found;
    }

    clear() {
        this.entries = [];
        this.pending = '';
    }

    #push(rawText, stream) {
        const entry = { ts: this.now(), stream, text: AnsiTags.convert(rawText) };
        this.entries.push(entry);
        if (this.entries.length > this.limit) {
            this.entries.splice(0, this.entries.length - this.limit);
        }
        return entry;
    }
}

/** Разбирает git-remote в хост и путь проекта. Понимает ssh и https. */
function parseGitLabRemote(url) {
    const text = String(url ?? '').trim();
    if (!text) {
        return null;
    }
    const ssh = text.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/);
    if (ssh) {
        return { host: ssh[1], projectPath: ssh[2] };
    }
    const https = text.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
    if (https) {
        return { host: https[1], projectPath: https[2] };
    }
    return null;
}

function readGitOutput(args, { repoRoot, spawnSyncImpl = spawnSync }) {
    const result = spawnSyncImpl('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        return '';
    }
    return String(result.stdout ?? '').trim();
}

/** Тонкая обёртка над GitLab REST API v4. Без зависимостей — fetch из Node 24. */
class GitLabClient {
    constructor({ host, projectPath, token, fetchImpl = globalThis.fetch }) {
        this.host = host;
        this.projectPath = projectPath;
        this.token = token;
        this.fetchImpl = fetchImpl;
    }

    url(pathname, params = {}) {
        const project = encodeURIComponent(this.projectPath);
        const query = new URLSearchParams(params).toString();
        const base = `https://${this.host}/api/v4/projects/${project}${pathname}`;
        return query ? `${base}?${query}` : base;
    }

    async request(pathname, params = {}, { raw = false, method = 'GET' } = {}) {
        const response = await this.fetchImpl(this.url(pathname, params), {
            method,
            headers: { 'PRIVATE-TOKEN': this.token },
        });
        if (!response.ok) {
            throw new Error(`GitLab ${response.status} ${pathname}`);
        }
        return raw ? response.text() : response.json();
    }

    pipelines({ ref, limit = 10 }) {
        const params = { per_page: String(limit) };
        if (ref) {
            params.ref = ref;
        }
        return this.request('/pipelines', params);
    }

    jobs(pipelineId) {
        return this.request(`/pipelines/${pipelineId}/jobs`, { per_page: '100' });
    }

    trace(jobId) {
        return this.request(`/jobs/${jobId}/trace`, {}, { raw: true });
    }

    /** Реестр контейнеров. Токену нужен scope read_registry. */
    registryRepositories() {
        return this.request('/registry/repositories', { tags: 'true', per_page: '100' });
    }

    registryTag(repositoryId, tagName) {
        return this.request(`/registry/repositories/${repositoryId}/tags/${tagName}`);
    }

    /** POST — нужен токен со scope "api", read_api для запуска не хватит. */
    createPipeline(ref) {
        return this.request('/pipeline', { ref }, { method: 'POST' });
    }

    cancelPipeline(pipelineId) {
        return this.request(`/pipelines/${pipelineId}/cancel`, {}, { method: 'POST' });
    }
}

const GITLAB_ICONS = {
    success: '✓',
    failed: '✗',
    running: '●',
    pending: '◌',
    created: '◌',
    canceled: '⏹',
    skipped: '⤼',
    manual: '⏸',
};

function gitlabIcon(status) {
    return GITLAB_ICONS[status] ?? '?';
}

/**
 * Пайплайны текущей ветки, джобы и трассы. Сеть только по запросу: ни один
 * рендер не ходит в GitLab сам.
 */
class PipelineStore extends EventEmitter {
    constructor({ client = null, ref = null, limit = 10, reason = '' }) {
        super();
        this.client = client;
        this.ref = ref;
        this.limit = limit;
        this.status = client ? 'idle' : 'disabled';
        this.reason = reason;
        this.items = [];
        this.jobsByPipeline = new Map();
        this.traces = new Map();
    }

    isEnabled() {
        return Boolean(this.client);
    }

    async refresh() {
        if (!this.client || this.status === 'loading') {
            return;
        }
        this.status = 'loading';
        this.emit('changed');
        try {
            const pipelines = await this.client.pipelines({ ref: this.ref, limit: this.limit });
            this.items = Array.isArray(pipelines) ? pipelines : [];
            this.status = 'ready';
            this.reason = '';
        } catch (error) {
            this.status = 'error';
            this.reason = error.message;
        }
        this.emit('changed');
    }

    jobs(pipelineId) {
        return this.jobsByPipeline.get(pipelineId) ?? null;
    }

    async loadJobs(pipelineId) {
        if (!this.client) {
            return;
        }
        try {
            const jobs = await this.client.jobs(pipelineId);
            this.jobsByPipeline.set(pipelineId, Array.isArray(jobs) ? jobs : []);
            this.reason = '';
        } catch (error) {
            this.status = 'error';
            this.reason = error.message;
        }
        this.emit('changed');
    }

    trace(jobId) {
        return this.traces.get(jobId) ?? null;
    }

    async loadTrace(jobId) {
        if (!this.client) {
            return;
        }
        try {
            this.traces.set(jobId, await this.client.trace(jobId));
            this.reason = '';
        } catch (error) {
            this.status = 'error';
            this.reason = error.message;
        }
        this.emit('changed');
    }

    hasRunning() {
        return this.items.some((pipeline) => pipeline.status === 'running');
    }

    /** Запуск пайплайна. Вызывать только после подтверждения пользователем. */
    async trigger(ref = this.ref) {
        if (!this.client) {
            return null;
        }
        try {
            const created = await this.client.createPipeline(ref);
            this.reason = `запущен пайплайн #${created?.id ?? '?'} на ${ref}`;
            await this.refresh();
            return created;
        } catch (error) {
            this.status = 'error';
            this.reason = error.message;
            this.emit('changed');
            return null;
        }
    }

    async cancel(pipelineId) {
        if (!this.client) {
            return;
        }
        try {
            await this.client.cancelPipeline(pipelineId);
            await this.refresh();
        } catch (error) {
            this.status = 'error';
            this.reason = error.message;
            this.emit('changed');
        }
    }
}

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
        return { digest: details.digest, createdAt: parseDockerDate(details.created_at) };
    }
}

/**
 * Кандидаты для отката. Основной источник — локальный кеш: там лежат прежние
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
 * Шаги отката. Compose ссылается на изменяемый тег, поэтому вместо правки файла
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

const TERMINAL_STATUSES = new Set(['finished', 'failed', 'stopped']);

/**
 * Одна запущенная команда. Статус берётся из событий процесса, а не из
 * process.kill(pid, 0): pid переиспользуются, и такая проверка врёт.
 */
class Task extends EventEmitter {
    constructor({
        id,
        spec,
        now = () => Date.now(),
        killTimeoutMs = KILL_TIMEOUT_MS,
        setTimeoutImpl = setTimeout,
        clearTimeoutImpl = clearTimeout,
        logLimit = LOG_LIMIT,
        platform = process.platform,
        spawnSyncImpl = spawnSync,
        killImpl = (pid, signal) => process.kill(pid, signal),
    }) {
        super();
        this.platform = platform;
        this.spawnSyncImpl = spawnSyncImpl;
        this.killImpl = killImpl;
        this.id = id;
        this.spec = spec;
        this.now = now;
        this.killTimeoutMs = killTimeoutMs;
        this.setTimeoutImpl = setTimeoutImpl;
        this.clearTimeoutImpl = clearTimeoutImpl;
        this.status = 'running';
        this.pid = null;
        this.exitCode = null;
        this.signal = null;
        this.createdAt = now();
        this.stoppedAt = null;
        this.child = null;
        this.killTimer = null;
        this.onStepDone = null;
        this.log = new LogBuffer({ limit: logLimit });
    }

    get workspace() {
        return this.spec.workspace;
    }

    get command() {
        return this.spec.command;
    }

    get runMode() {
        return this.spec.runMode;
    }

    isRunning() {
        return this.status === 'running';
    }

    attach(child) {
        this.child = child;
        this.pid = child.pid ?? null;
        child.stdout?.on('data', (data) => this.#write(data, 'stdout'));
        child.stderr?.on('data', (data) => this.#write(data, 'stderr'));
        child.on('error', (error) => {
            this.#write(`child_process error: ${error.message}\n`, 'stderr');
            this.#transition('failed');
        });
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
    }

    /**
     * Мы спавним npm, а он — node/nest/vite, который и держит порт. Поэтому убивать
     * надо всё дерево: одиночный kill по pid снимает npm, а внук продолжает слушать
     * порт, и следующий запуск падает с EADDRINUSE.
     */
    stop() {
        if (!this.isRunning()) {
            return;
        }
        this.#terminate(false);
        this.#write('stop requested by user\n', 'stdout');
        this.killTimer = this.setTimeoutImpl(() => this.#terminate(true), this.killTimeoutMs);
        this.#transition('stopped');
    }

    #terminate(force) {
        if (!this.pid) {
            return;
        }
        if (this.platform === 'win32') {
            // На Windows сигналов нет: taskkill /T снимает дерево процессов,
            // /F добавляет принудительность на втором заходе.
            const args = ['/PID', String(this.pid), '/T'];
            if (force) {
                args.push('/F');
            }
            try {
                this.spawnSyncImpl('taskkill', args, { windowsHide: true });
            } catch (error) {
                this.#write(`taskkill failed: ${error.message}\n`, 'stderr');
            }
            return;
        }
        // На POSIX процесс запущен лидером своей группы (detached), поэтому
        // отрицательный pid бьёт по всей группе — npm вместе с детьми.
        const signal = force ? 'SIGKILL' : 'SIGTERM';
        try {
            this.killImpl(-this.pid, signal);
        } catch {
            try {
                this.killImpl(this.pid, signal);
            } catch {
                // процесс уже умер — добивать нечего
            }
        }
    }

    runtime(nowMs = this.now()) {
        const end = this.stoppedAt ?? nowMs;
        const totalSeconds = Math.max(0, Math.floor((end - this.createdAt) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        return `${minutes}:${seconds}`;
    }

    noteStepFailure(step, total, code) {
        this.#write(`шаг ${step} из ${total} завершился с кодом ${code}\n`, 'stderr');
    }

    #write(chunk, stream) {
        this.#emitLines(this.log.append(chunk, stream));
    }

    #emitLines(added) {
        if (added.length > 0) {
            this.emit('lines', added);
        }
    }

    #transition(next) {
        if (TERMINAL_STATUSES.has(this.status)) {
            return;
        }
        this.status = next;
        this.stoppedAt = this.now();
        if (this.killTimer !== null && next !== 'stopped') {
            this.clearTimeoutImpl(this.killTimer);
            this.killTimer = null;
        }
        this.emit('status', next);
    }
}

/** Единственный владелец состояния задач. */
class TaskManager extends EventEmitter {
    constructor({
        repoRoot,
        spawnImpl = spawn,
        spawnSyncImpl = spawnSync,
        idFactory = () => randomUUID().slice(0, 8),
        taskOptions = {},
        platform = process.platform,
    }) {
        super();
        this.repoRoot = repoRoot;
        this.spawnImpl = spawnImpl;
        this.spawnSyncImpl = spawnSyncImpl;
        this.idFactory = idFactory;
        this.platform = platform;
        // Платформу и spawnSync задача получает от менеджера: ей они нужны, чтобы
        // снимать дерево процессов.
        this.taskOptions = { platform, spawnSyncImpl, ...taskOptions };
        /** @type {Task[]} */
        this.items = [];
    }

    /** Опции спавна живут в одном месте: их легко нарушить по-разному в трёх копиях. */
    #spawn(target) {
        return this.spawnImpl(target.command, target.args, {
            cwd: target.cwd ?? this.repoRoot,
            // На POSIX процесс становится лидером своей группы — только так стоп
            // сможет прибить и npm, и его детей (node/nest/vite держат порт).
            // На Windows группы нет, там дерево снимает taskkill /T.
            detached: this.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: target.shell === true,
            windowsHide: true,
        });
    }

    #register(task) {
        task.on('status', () => this.emit('changed'));
        this.items.push(task);
        this.emit('changed');
        return task;
    }

    start({ command, workspace, runMode = 'default' }) {
        const spec = new NpmCommand({ command, workspace, runMode, platform: this.platform });
        const task = new Task({ id: this.idFactory(), spec, ...this.taskOptions });
        task.attach(this.#spawn(spec.spawnTarget()));
        return this.#register(task);
    }

    /** Общий запуск любой спеки команды: npm, docker, make, shell. */
    startCommand(spec) {
        const task = new Task({ id: this.idFactory(), spec, ...this.taskOptions });
        task.attach(this.#spawn(spec.spawnTarget()));
        return this.#register(task);
    }

    /** Одна команда docker как задача: логи, рестарт, стоп. */
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

    /**
     * Задача из цепочки команд. Между шагами задача остаётся running, ненулевой
     * код прерывает остаток — в логе видно, на каком шаге всё встало.
     */
    startSequence({ label, targets, workspace = null }) {
        const spec = new CommandSequence({ label, targets, workspace });
        const task = new Task({ id: this.idFactory(), spec, ...this.taskOptions });
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
        return this.#register(task);
    }

    runForeground({ command, workspace, runMode = 'default' }) {
        const spec = new NpmCommand({ command, workspace, runMode, platform: this.platform });
        const target = spec.spawnTarget();
        const result = this.spawnSyncImpl(target.command, target.args, {
            cwd: this.repoRoot,
            stdio: 'inherit',
            shell: target.shell === true,
            windowsHide: true,
        });
        return result.status ?? 1;
    }

    stop(id) {
        this.get(id)?.stop();
    }

    stopAll() {
        for (const task of this.items) {
            if (task.isRunning()) {
                task.stop();
            }
        }
    }

    forget(id) {
        const task = this.get(id);
        if (!task || task.isRunning()) {
            return false;
        }
        this.items = this.items.filter((item) => item.id !== id);
        this.emit('changed');
        return true;
    }

    tasks() {
        return [...this.items].reverse();
    }

    get(id) {
        return this.items.find((task) => task.id === id) ?? null;
    }

    hasRunning() {
        return this.items.some((task) => task.isRunning());
    }

    runningCount() {
        return this.items.filter((task) => task.isRunning()).length;
    }

    counters() {
        let running = 0;
        let done = 0;
        let failed = 0;
        for (const task of this.items) {
            if (task.status === 'running') {
                running += 1;
            } else if (task.status === 'failed') {
                failed += 1;
            } else {
                done += 1;
            }
        }
        return { running, done, failed };
    }
}

// Enter — это только "return" (последовательность "\r"). "linefeed" сюда намеренно
// не входит: терминал, присылающий "\r\n", дал бы return + linefeed, то есть два
// подтверждения на одно нажатие. Синтетический "enter" гасится в TuiApp.onKey.
const CONFIRM_KEYS = new Set(['return', 'enter']);

// Режим запуска переключается Tab прямо в колонке сервисов — отдельного экрана нет.
const RUN_MODES = [
    { label: 'Обычный', value: 'default' },
    { label: 'Watch', value: 'watch' },
    { label: 'В терминале', value: 'foreground' },
];

const STATUS_ICONS = {
    running: '●',
    finished: '✓',
    failed: '✗',
    stopped: '⏹',
};

function taskTail(task) {
    if (task.status === 'running') {
        return task.runtime();
    }
    if (task.status === 'stopped') {
        return 'stopped';
    }
    return `exit ${task.exitCode ?? '-'}`;
}

/** Плоский список строк левой панели: команды, живые задачи, завершённые. */
class SidePanelModel {
    constructor({ index, manager, pipelines = null, compose = null }) {
        this.index = index;
        this.manager = manager;
        this.pipelines = pipelines;
        this.compose = compose;
        this.items = [];
        this.cursor = 0;
        this.cursorKey = null;
    }

    rebuild() {
        const tasks = this.manager.tasks();
        const running = tasks.filter((task) => task.status === 'running');
        const done = tasks.filter((task) => task.status !== 'running');
        const rows = [];

        rows.push({
            kind: 'header',
            key: 'header:commands',
            label: '▶ Команды',
            selectable: false,
        });
        for (const command of this.index.commands()) {
            rows.push({
                kind: 'command',
                key: `command:${command}`,
                label: `  ${command}`,
                selectable: true,
                command,
            });
        }
        rows.push({
            kind: 'header',
            key: 'header:running',
            label: `● Запущено (${running.length})`,
            selectable: false,
        });
        for (const task of running) {
            rows.push(this.#taskRow(task));
        }
        rows.push({
            kind: 'header',
            key: 'header:done',
            label: `✓ Завершено (${done.length})`,
            selectable: false,
        });
        for (const task of done) {
            rows.push(this.#taskRow(task));
        }
        this.#pushPipelineRows(rows);
        this.#pushComposeRows(rows);

        this.items = rows;
        this.#restoreCursor();
    }

    rows() {
        return this.items;
    }

    cursorRowIndex() {
        return this.cursor;
    }

    selected() {
        return this.items[this.cursor] ?? null;
    }

    selectKey(key) {
        const found = this.items.findIndex((row) => row.selectable && row.key === key);
        if (found >= 0) {
            this.cursor = found;
            this.cursorKey = key;
        }
    }

    moveCursor(delta) {
        const step = delta > 0 ? 1 : -1;
        let position = this.cursor;
        for (let moves = 0; moves < Math.abs(delta); moves += 1) {
            let next = position + step;
            while (next >= 0 && next < this.items.length && !this.items[next].selectable) {
                next += step;
            }
            if (next < 0 || next >= this.items.length) {
                break;
            }
            position = next;
        }
        this.cursor = position;
        this.cursorKey = this.items[position]?.key ?? null;
    }

    #pushPipelineRows(rows) {
        const store = this.pipelines;
        if (!store) {
            return;
        }
        const ref = store.ref ? ` ${store.ref}` : '';
        rows.push({
            kind: 'header',
            key: 'header:pipelines',
            label: `⚙ Пайплайны${ref} (${store.items.length})`,
            selectable: false,
        });
        for (const pipeline of store.items) {
            rows.push({
                kind: 'pipeline',
                key: `pipeline:${pipeline.id}`,
                label: `  ${gitlabIcon(pipeline.status)} #${pipeline.id} ${pipeline.status}`,
                selectable: true,
                pipeline,
            });
        }
    }

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

    #taskRow(task) {
        const icon = STATUS_ICONS[task.status] ?? '?';
        return {
            kind: 'task',
            key: `task:${task.id}`,
            label: `  ${icon} ${task.workspace} ${task.command} ${taskTail(task)}`,
            selectable: true,
            task,
        };
    }

    #restoreCursor() {
        if (this.cursorKey) {
            const found = this.items.findIndex(
                (row) => row.selectable && row.key === this.cursorKey
            );
            if (found >= 0) {
                this.cursor = found;
                return;
            }
        }
        // Элемент исчез (задачу забыли или она уехала в другую секцию) — остаёмся
        // на той же позиции, а не прыгаем в начало списка.
        const target = Math.max(0, Math.min(this.cursor, this.items.length - 1));
        const next = this.#nearestSelectable(target, 1) ?? this.#nearestSelectable(target, -1);
        this.cursor = next ?? 0;
        this.cursorKey = this.items[this.cursor]?.key ?? null;
    }

    #nearestSelectable(from, step) {
        for (let index = from; index >= 0 && index < this.items.length; index += step) {
            if (this.items[index].selectable) {
                return index;
            }
        }
        return null;
    }
}

/** Стек видов: backspace = pop, на корне ничего не делает. */
class NavigationStack {
    constructor(rootView) {
        this.views = [rootView];
    }

    get depth() {
        return this.views.length;
    }

    push(view) {
        this.views.push(view);
    }

    pop() {
        if (this.views.length <= 1) {
            return null;
        }
        return this.views.pop();
    }

    top() {
        return this.views[this.views.length - 1];
    }
}

class SearchState {
    static nextMatch(matches, position, delta) {
        if (matches.length === 0) {
            return 0;
        }
        return (position + delta + matches.length) % matches.length;
    }
}

function assertTerminal({ stdout = process.stdout } = {}) {
    if (!stdout.isTTY) {
        throw new Error('Нужен интерактивный терминал: запусти без пайпов и не в CI.');
    }
    const columns = stdout.columns ?? 0;
    const rows = stdout.rows ?? 0;
    if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
        throw new Error(`Нужен терминал не меньше 80×24, сейчас ${columns}×${rows}.`);
    }
    return true;
}

/**
 * Собирает хранилище пайплайнов из git-remote и GITLAB_TOKEN. Токен читается
 * только из окружения и никуда не пишется. Нет токена или не GitLab — секция
 * молча выключена с объяснением.
 */
function createPipelineStore({ repoRoot, env = process.env, spawnSyncImpl = spawnSync }) {
    const remote = parseGitLabRemote(
        readGitOutput(['remote', 'get-url', 'origin'], { repoRoot, spawnSyncImpl })
    );
    const ref =
        readGitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], { repoRoot, spawnSyncImpl }) || null;
    if (!remote) {
        return new PipelineStore({ reason: 'origin не похож на GitLab.', ref });
    }
    const token = env.GITLAB_TOKEN;
    if (!token) {
        return new PipelineStore({
            reason: 'Нужен GITLAB_TOKEN в окружении (scope read_api; для запуска — api).',
            ref,
        });
    }
    return new PipelineStore({
        client: new GitLabClient({ host: remote.host, projectPath: remote.projectPath, token }),
        ref,
    });
}

function selfCheck({ repoRoot, roots = null, stdout = process.stdout }) {
    const scanRoots = roots ?? workspaceRoots(repoRoot);
    const index = new WorkspaceIndex({ repoRoot, roots: scanRoots });
    index.refresh();
    stdout.write(
        `${[
            `root=${repoRoot}`,
            `roots=${scanRoots.join(',')}`,
            `packages=${index.packages().length}`,
            `commands=${index.commands().length}`,
        ].join(' ')}\n`
    );
    return 0;
}

class View {
    constructor(app) {
        this.app = app;
        this.title = '';
        this.widgets = [];
    }

    mount() {}

    unmount() {
        for (const widget of this.widgets) {
            widget.detach();
        }
        this.widgets = [];
    }

    handleKey() {
        return false;
    }

    hotkeys() {
        return '';
    }

    tick() {}
}

class HomeView extends View {
    constructor(app) {
        super(app);
        this.title = 'Задачи';
        this.model = new SidePanelModel({
            index: app.index,
            manager: app.manager,
            pipelines: app.pipelines,
            compose: app.compose,
        });
        this.focus = 'side';
        // Показ таймстемпов — глобальная настройка отображения, а не свойство пункта.
        this.showTimestamps = false;
        // Состояние правой колонки помнится для каждого пункта левой отдельно:
        // фильтр и курсор сервисов, режим запуска, поиск, прокрутка, открытая трасса.
        /** @type {Map<string, object>} */
        this.states = new Map();
        this.activeKey = null;
        this.pendingScroll = null;
        Object.assign(this, this.freshState(0));
        this.onChanged = () => {
            this.model.rebuild();
            this.render();
            this.app.render();
        };
    }

    mount() {
        const blessed = this.app.blessed;
        if (this.zoom) {
            // Режим копирования: одна колонка на весь экран, без рамок и отступов.
            // Мышью выделяется только текст лога — левое меню в выделение не попадает.
            this.side = null;
            this.right = blessed.box({
                parent: this.app.body,
                left: 0,
                top: 0,
                right: 0,
                height: '100%',
                tags: true,
                scrollable: true,
                alwaysScroll: true,
                keys: false,
            });
            this.widgets = [this.right];
        } else {
            this.side = blessed.box({
                parent: this.app.body,
                left: 0,
                top: 0,
                width: SIDE_WIDTH,
                height: '100%',
                border: 'line',
                label: ' Задачи ',
                tags: true,
                scrollable: true,
                alwaysScroll: true,
                // Отступ от рамок: без него текст прилипает к "│", и Ctrl+click в
                // VS Code уносит рамку в путь файла вместе со ссылкой.
                padding: { left: 1, right: 1 },
            });
            // Правая колонка одна и меняется по контексту левой: на команде — её
            // сервисы, на задаче — её лог.
            this.right = blessed.box({
                parent: this.app.body,
                left: SIDE_WIDTH,
                top: 0,
                right: 0,
                height: '100%',
                border: 'line',
                label: ' Лог ',
                tags: true,
                scrollable: true,
                alwaysScroll: true,
                keys: false,
                scrollbar: { ch: ' ', style: { bg: 'grey' } },
                padding: { left: 1, right: 1 },
            });
            this.widgets = [this.side, this.right];
        }
        this.model.rebuild();
        this.syncServices();
        this.app.manager.on('changed', this.onChanged);
        this.render();
    }

    /** Чистое состояние правой колонки. Режим наследуется от текущего пункта. */
    freshState(modeIndex = this.modeIndex ?? 0) {
        return {
            // Вторая колонка: сервисы выбранной команды. Модалок нет — Enter по
            // команде просто переводит фокус вправо.
            // Выбор храним идентификатором, а не индексом: список сервисов меняется
            // от фильтра, список джоб — от обновления пайплайна, и индекс начинает
            // указывать на чужую строку.
            services: { command: null, items: [], selectedRel: null, filter: '' },
            containers: { filter: '', selectedService: null },
            jobs: { pipelineId: null, selectedJobId: null },
            trace: { jobId: null, buffer: null },
            search: { active: false, pattern: '', matches: [], position: 0 },
            autoScroll: true,
            modeIndex,
            scroll: 0,
        };
    }

    /**
     * Переключение пункта слева: складываем состояние прежнего и достаём состояние
     * нового. Благодаря этому возврат к задаче или команде выглядит так, как ты её
     * оставил — с тем же фильтром, режимом, поиском и прокруткой.
     */
    syncActiveKey() {
        const row = this.model.selected();
        const key = row?.key ?? null;
        if (key === this.activeKey) {
            return;
        }
        this.captureState();
        this.activeKey = key;
        if (!key) {
            return;
        }
        let state = this.states.get(key);
        if (!state) {
            state = this.freshState();
            this.states.set(key, state);
        }
        this.services = state.services;
        this.containers = state.containers;
        this.jobs = state.jobs;
        this.trace = state.trace;
        this.search = state.search;
        this.autoScroll = state.autoScroll;
        this.modeIndex = state.modeIndex;
        this.pendingScroll = state.scroll;
    }

    captureState() {
        if (!this.activeKey) {
            return;
        }
        const state = this.states.get(this.activeKey);
        if (!state) {
            return;
        }
        state.services = this.services;
        state.containers = this.containers;
        state.jobs = this.jobs;
        state.trace = this.trace;
        state.search = this.search;
        state.autoScroll = this.autoScroll;
        state.modeIndex = this.modeIndex;
        const scroll = this.right?.getScroll?.();
        if (typeof scroll === 'number') {
            state.scroll = scroll;
        }
    }

    runMode() {
        return RUN_MODES[this.modeIndex];
    }

    toggleRunMode() {
        this.modeIndex = (this.modeIndex + 1) % RUN_MODES.length;
        this.render();
    }

    /**
     * Что показывает правая колонка: сервисы команды, лог задачи, джобы пайплайна
     * или трассу выбранной джобы.
     */
    rightContext() {
        if (this.trace.jobId !== null) {
            return 'trace';
        }
        const kind = this.model.selected()?.kind;
        if (kind === 'command') {
            return 'services';
        }
        if (kind === 'compose') {
            return 'containers';
        }
        if (kind === 'pipeline') {
            return 'jobs';
        }
        return 'log';
    }

    selectedPipeline() {
        const row = this.model.selected();
        return row?.kind === 'pipeline' ? row.pipeline : null;
    }

    visibleJobs() {
        const pipeline = this.selectedPipeline();
        if (!pipeline) {
            return [];
        }
        return this.app.pipelines?.jobs(pipeline.id) ?? [];
    }

    /** Индекс выводится из id, а не хранится: список джоб пересоздаётся при обновлении. */
    jobCursor() {
        const jobs = this.visibleJobs();
        const found = jobs.findIndex((job) => job.id === this.jobs.selectedJobId);
        return found >= 0 ? found : 0;
    }

    selectedJob() {
        return this.visibleJobs()[this.jobCursor()] ?? null;
    }

    moveJobCursor(delta) {
        const jobs = this.visibleJobs();
        if (jobs.length === 0) {
            return;
        }
        const next = Math.max(0, Math.min(jobs.length - 1, this.jobCursor() + delta));
        this.jobs.selectedJobId = jobs[next].id;
    }

    /** Список сервисов идёт за курсором левой колонки, без нажатий. */
    syncServices() {
        const row = this.model.selected();
        if (row?.kind !== 'command') {
            return;
        }
        if (row.command !== this.services.command) {
            this.services = { command: row.command, items: [], cursor: 0, filter: '' };
        }
        this.services.items = this.app.index.packagesWithCommand(row.command);
    }

    visibleServices() {
        const needle = this.services.filter.toLowerCase();
        return this.services.items.filter(
            (pkg) =>
                pkg.rel.toLowerCase().includes(needle) || pkg.name.toLowerCase().includes(needle)
        );
    }

    /**
     * Первая строка — псевдосервис для операций над всем проектом. Выбор хранится
     * именем сервиса: список меняется от фильтра и от обновления ps.
     */
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

    /** Буквы тут — фильтр, поэтому действия висят на Enter и живут в меню. */
    handleContainersKey(chunk, key) {
        const name = key?.name;
        if (name === 'up' || name === 'down') {
            this.moveContainerCursor(name === 'down' ? 1 : -1);
            this.render();
            return true;
        }
        if (CONFIRM_KEYS.has(name)) {
            const row = this.selectedContainer();
            if (row) {
                this.openContainerMenu(row);
            }
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
        if (
            !key?.ctrl &&
            !key?.meta &&
            typeof chunk === 'string' &&
            chunk.length === 1 &&
            chunk >= ' '
        ) {
            this.containers.filter += chunk;
            this.render();
            return true;
        }
        return false;
    }

    /**
     * Действия — пунктами меню, а не буквами: буквы в этой колонке заняты фильтром,
     * а случайная буква на проде стоит развёртывания.
     */
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
            new MenuView(this.app, {
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

    /** То же и для сервисов: индекс считаем от выбранного rel, фильтр его не сбивает. */
    serviceCursor() {
        const rows = this.visibleServices();
        const found = rows.findIndex((pkg) => pkg.rel === this.services.selectedRel);
        return found >= 0 ? found : 0;
    }

    selectedService() {
        return this.visibleServices()[this.serviceCursor()] ?? null;
    }

    moveServiceCursor(delta) {
        const rows = this.visibleServices();
        if (rows.length === 0) {
            return;
        }
        const next = Math.max(0, Math.min(rows.length - 1, this.serviceCursor() + delta));
        this.services.selectedRel = rows[next].rel;
    }

    unmount() {
        this.app.manager.removeListener('changed', this.onChanged);
        super.unmount();
    }

    selectedTask() {
        const row = this.model.selected();
        return row && row.kind === 'task' ? row.task : null;
    }

    tick() {
        this.model.rebuild();
        this.render();
    }

    render() {
        // Порядок важен: сперва подменяем состояние под выбранный пункт, потом
        // синхронизируем сервисы — иначе фильтр применится к прежнему состоянию.
        this.syncActiveKey();
        // Синхронизация тут, а не только на движении курсора: иначе после возврата
        // из лога на команду правая колонка оставалась пустой до следующей стрелки.
        this.syncServices();
        const rows = this.model.rows();
        const cursor = this.model.cursorRowIndex();
        if (this.side) {
            this.renderSide(rows, cursor);
        }
        this.renderRight();
    }

    renderSide(rows, cursor) {
        this.side.setContent(
            rows
                .map((row, position) => {
                    if (position === cursor && row.selectable) {
                        return `{inverse}${row.label}{/}`;
                    }
                    return row.kind === 'header' ? `{cyan-fg}{bold}${row.label}{/}` : row.label;
                })
                .join('\n')
        );
        // Список команд, задач и пайплайнов длиннее окна — держим курсор в виду,
        // иначе нижние элементы просто не показываются.
        this.side.scrollTo(cursor);
    }

    renderRight() {
        const context = this.rightContext();
        if (context === 'services') {
            this.renderServices();
        } else if (context === 'containers') {
            this.renderContainers();
        } else if (context === 'jobs') {
            this.renderJobs();
        } else if (context === 'trace') {
            this.renderTrace();
        } else {
            this.renderLog();
        }
        // Прокрутку возвращаем после наполнения колонки: до setContent blessed
        // ещё не знает высоту содержимого и обрежет позицию.
        if (this.pendingScroll !== null) {
            if (!this.autoScroll && this.pendingScroll > 0) {
                this.right.scrollTo(this.pendingScroll);
            }
            this.pendingScroll = null;
        }
        if (this.side) {
            this.side.style.border = { fg: this.focus === 'side' ? 'cyan' : 'white' };
            this.right.style.border = { fg: this.focus === 'right' ? 'cyan' : 'white' };
        }
    }

    /** Лог на весь экран без рамок: чтобы выделение мышью не хватало левое меню. */
    toggleZoom() {
        this.captureState();
        this.unmount();
        this.zoom = !this.zoom;
        if (this.zoom) {
            this.focus = 'right';
        }
        this.mount();
        this.app.render();
    }

    /** Копирование текущего содержимого в буфер обмена — мышь не нужна вовсе. */
    copyActive() {
        const buffer = this.activeBuffer();
        if (!buffer) {
            this.app.notify('Копировать нечего: выбери задачу или трассу.');
            return;
        }
        const text = bufferToText(buffer, { withTimestamps: this.showTimestamps });
        const where = this.app.clipboard(text);
        const lines = buffer.lines().length;
        this.app.notify(
            where
                ? `Скопировано строк: ${lines} → ${where}`
                : 'Не удалось скопировать: нет ни утилиты, ни OSC 52.'
        );
    }

    renderServices() {
        const command = this.services.command;
        const rows = this.visibleServices();
        const cursor = this.serviceCursor();
        // Режим и фильтр живут в заголовке рамки, а не в содержимом: содержимое
        // скроллится вслед за курсором и увозило бы их за край.
        const filter = this.services.filter ? `/${this.services.filter}` : 'без фильтра';
        this.right.setLabel(
            ` ${command} • режим: ${this.runMode().label} • ${filter} • ${rows.length} `
        );
        const body =
            rows.length === 0
                ? ['{grey-fg}Ничего не найдено.{/}']
                : rows.map((pkg, position) => {
                      const active = this.focus === 'right' && position === cursor;
                      return active
                          ? `{inverse}${pkg.rel} (${pkg.name}){/}`
                          : `${pkg.rel} {grey-fg}(${pkg.name}){/}`;
                  });
        this.right.setContent(body.join('\n'));
        // Курсор в списке из 43 сервисов уезжает за край окна — держим его в виду.
        if (this.focus === 'right') {
            this.right.scrollTo(cursor);
        }
    }

    renderJobs() {
        const pipeline = this.selectedPipeline();
        const store = this.app.pipelines;
        this.right.setLabel(` Джобы #${pipeline.id} (${pipeline.status}) `);
        const jobs = this.visibleJobs();
        if (!store?.isEnabled()) {
            this.right.setContent(`{grey-fg}${store?.reason || 'GitLab не настроен.'}{/}`);
            return;
        }
        if (jobs.length === 0) {
            this.right.setContent('{grey-fg}Джобы ещё не загружены — Enter или r.{/}');
            return;
        }
        const cursor = this.jobCursor();
        const lines = jobs.map((job, position) => {
            const duration = job.duration ? `${Math.round(job.duration)}s` : '-';
            const text = `${gitlabIcon(job.status)} ${job.stage} / ${job.name}  ${duration}`;
            const active = this.focus === 'right' && position === cursor;
            return active ? `{inverse}${text}{/}` : text;
        });
        this.right.setContent(lines.join('\n'));
        if (this.focus === 'right') {
            this.right.scrollTo(cursor);
        }
    }

    /** Джобу для трассы ищем по id: список мог перезагрузиться. */
    traceJob() {
        if (this.trace.jobId === null) {
            return null;
        }
        return this.visibleJobs().find((job) => job.id === this.trace.jobId) ?? null;
    }

    renderTrace() {
        const job = this.traceJob() ?? { stage: '?', name: `#${this.trace.jobId}` };
        const searchSuffix = this.search.active
            ? `[/${this.search.pattern} ${this.search.matches.length} совп.] `
            : '';
        this.right.setLabel(` Трасса: ${job.stage} / ${job.name} ${searchSuffix}`);
        const lines = this.trace.buffer?.lines() ?? [];
        this.right.setContent(
            lines.length === 0
                ? '{grey-fg}Трасса пуста или ещё грузится.{/}'
                : lines.map((line, index) => this.formatLine(line, index)).join('\n')
        );
        if (this.autoScroll) {
            this.right.setScrollPerc(100);
        }
    }

    renderLog() {
        const task = this.selectedTask();
        const searchSuffix = this.search.active
            ? `[/${this.search.pattern} ${this.search.matches.length} совп.] `
            : '';
        this.right.setLabel(
            task ? ` Лог: ${task.spec.label()} ${searchSuffix}` : ` Лог ${searchSuffix}`
        );
        const lines = task ? task.log.lines() : [];
        this.right.setContent(
            lines.length === 0
                ? '{grey-fg}Лог пуст.{/}'
                : lines.map((line, index) => this.formatLine(line, index)).join('\n')
        );
        if (this.autoScroll) {
            this.right.setScrollPerc(100);
        }
    }

    formatLine(line, index) {
        const stamp = this.showTimestamps
            ? `{grey-fg}${line.ts.toISOString().slice(11, 19)}{/} `
            : '';
        if (this.search.active && this.search.matches.includes(index)) {
            return `${stamp}{yellow-bg}{black-fg}${line.text}{/}`;
        }
        if (line.stream === 'stderr') {
            return `${stamp}{red-fg}${line.text}{/}`;
        }
        return `${stamp}${line.text}`;
    }

    /** Поиск работает и по логу задачи, и по трассе джобы — буфер один и тот же класс. */
    activeBuffer() {
        if (this.rightContext() === 'trace') {
            return this.trace.buffer;
        }
        return this.selectedTask()?.log ?? null;
    }

    applySearch() {
        const buffer = this.activeBuffer();
        this.search.matches = buffer ? buffer.search(this.search.pattern) : [];
        this.search.position = 0;
        this.scrollToMatch();
    }

    scrollToMatch() {
        const target = this.search.matches[this.search.position];
        if (typeof target === 'number') {
            this.autoScroll = false;
            this.right.scrollTo(target);
        }
        this.render();
    }

    handleKey(chunk, key) {
        const name = key?.name;
        // В правой колонке с сервисами буквы заняты фильтром, поэтому её клавиши
        // разбираются первыми и до буквенных хоткеев дело не доходит.
        if (this.focus === 'right' && this.rightContext() === 'services') {
            if (this.handleServicesKey(chunk, key)) {
                return true;
            }
        }
        if (this.focus === 'right' && this.rightContext() === 'containers') {
            if (this.handleContainersKey(chunk, key)) {
                return true;
            }
        }
        if (this.focus === 'right' && this.rightContext() === 'jobs') {
            if (this.handleJobsKey(chunk, key)) {
                return true;
            }
        }
        if (this.rightContext() === 'trace' && (name === 'escape' || name === 'left')) {
            this.trace = { jobId: null, buffer: null };
            this.search = { active: false, pattern: '', matches: [], position: 0 };
            this.render();
            return true;
        }
        if (name === 'left' && this.focus === 'right') {
            this.focus = 'side';
            this.render();
            return true;
        }
        if (name === 'right' && this.focus === 'side') {
            this.focus = 'right';
            this.render();
            return true;
        }
        // Tab всегда переключает окно, в любой колонке и любом контексте.
        if (name === 'tab') {
            this.focus = this.focus === 'side' ? 'right' : 'side';
            if (this.focus === 'right') {
                this.syncServices();
            }
            this.render();
            return true;
        }
        if (name === 'space' || chunk === ' ') {
            this.toggleRunMode();
            return true;
        }
        if (name === 'up' || name === 'down') {
            if (this.focus === 'side') {
                this.model.moveCursor(name === 'down' ? 1 : -1);
                this.syncServices();
            } else {
                this.autoScroll = false;
                this.right.scroll(name === 'down' ? 1 : -1);
            }
            this.render();
            return true;
        }
        if (CONFIRM_KEYS.has(name)) {
            const row = this.model.selected();
            if (row?.kind === 'command') {
                this.syncServices();
                this.focus = 'right';
                this.render();
            } else if (row?.kind === 'task') {
                this.focus = 'right';
                this.autoScroll = true;
                this.render();
            } else if (row?.kind === 'pipeline') {
                this.openPipeline(row.pipeline);
            }
            return true;
        }
        if (name === 'p') {
            this.app.requestPipelineRun();
            return true;
        }
        if (chunk === '/') {
            this.search = { active: true, pattern: '', matches: [], position: 0 };
            this.render();
            return true;
        }
        // Блок поиска стоит до "n": при активном поиске "n" — следующее совпадение,
        // а не визард запуска.
        if (this.search.active) {
            if (name === 'escape') {
                this.search = { active: false, pattern: '', matches: [], position: 0 };
                this.render();
                return true;
            }
            if (chunk === 'N' || name === 'n') {
                this.search.position = SearchState.nextMatch(
                    this.search.matches,
                    this.search.position,
                    chunk === 'N' ? -1 : 1
                );
                this.scrollToMatch();
                return true;
            }
            if (name === 'backspace') {
                if (this.search.pattern.length === 0) {
                    this.search.active = false;
                    this.render();
                    return true;
                }
                this.search.pattern = this.search.pattern.slice(0, -1);
                this.applySearch();
                return true;
            }
            if (!key?.ctrl && !key?.meta && typeof chunk === 'string' && chunk.length === 1 && chunk >= ' ') {
                this.search.pattern += chunk;
                this.applySearch();
                return true;
            }
        }
        if (name === 't') {
            this.showTimestamps = !this.showTimestamps;
            this.render();
            return true;
        }
        if (name === 'z') {
            this.toggleZoom();
            return true;
        }
        if (name === 'y') {
            this.copyActive();
            return true;
        }
        if (name === 'd') {
            const task = this.selectedTask();
            if (task) {
                this.app.manager.forget(task.id);
            }
            return true;
        }
        if (name === 'i') {
            const task = this.selectedTask();
            if (task) {
                this.app.push(new TaskDetailsView(this.app, task));
            }
            return true;
        }
        if (chunk === '?') {
            this.app.push(new HelpView(this.app));
            return true;
        }
        if (name === 'pageup' || name === 'pagedown') {
            this.autoScroll = false;
            this.right.scroll(name === 'pagedown' ? this.right.height : -this.right.height);
            return true;
        }
        if (name === 'home' || name === 'end') {
            this.autoScroll = name === 'end';
            this.right.setScrollPerc(name === 'end' ? 100 : 0);
            return true;
        }
        // "S" проверяется до "s", иначе Shift+S остановит только выбранную задачу.
        if (chunk === 'S') {
            this.app.manager.stopAll();
            return true;
        }
        if (name === 's') {
            const pipeline = this.selectedPipeline();
            if (pipeline) {
                this.app.requestPipelineCancel(pipeline);
                return true;
            }
            const task = this.selectedTask();
            if (task?.isRunning()) {
                task.stop();
            }
            return true;
        }
        if (name === 'r') {
            this.app.index.refresh();
            void this.app.compose?.refresh();
            this.model.rebuild();
            this.syncServices();
            const pipeline = this.selectedPipeline();
            void this.app.pipelines?.refresh().then(() => {
                if (pipeline) {
                    return this.app.pipelines.loadJobs(pipeline.id);
                }
                return undefined;
            });
            this.render();
            return true;
        }
        return false;
    }

    /** Enter по пайплайну: подтягиваем джобы и уходим фокусом вправо. */
    openPipeline(pipeline) {
        this.jobs = { pipelineId: pipeline.id, cursor: 0 };
        this.focus = 'right';
        if (!this.app.pipelines?.jobs(pipeline.id)) {
            void this.app.pipelines?.loadJobs(pipeline.id);
        }
        this.render();
    }

    /** Клавиши списка джоб: Enter тянет трассу в ту же колонку. */
    handleJobsKey(chunk, key) {
        const name = key?.name;
        if (name === 'up' || name === 'down') {
            this.moveJobCursor(name === 'down' ? 1 : -1);
            this.render();
            return true;
        }
        if (CONFIRM_KEYS.has(name)) {
            const job = this.selectedJob();
            if (job) {
                void this.openTrace(job);
            }
            return true;
        }
        if (name === 'escape' || name === 'left') {
            this.focus = 'side';
            this.render();
            return true;
        }
        return false;
    }

    async openTrace(job) {
        const store = this.app.pipelines;
        this.trace = { jobId: job.id, buffer: new LogBuffer() };
        this.autoScroll = true;
        this.render();
        this.app.render();
        if (!store?.trace(job.id)) {
            await store?.loadTrace(job.id);
        }
        const text = store?.trace(job.id) ?? '';
        this.trace.buffer = new LogBuffer();
        this.trace.buffer.append(`${text}\n`);
        this.render();
        this.app.render();
    }

    /** Клавиши колонки сервисов: буквы — фильтр, Tab — режим, Enter — запуск. */
    handleServicesKey(chunk, key) {
        const name = key?.name;
        if (name === 'up' || name === 'down') {
            this.moveServiceCursor(name === 'down' ? 1 : -1);
            this.render();
            return true;
        }
        // Пробел меняет режим и при набранном фильтре: в путях воркспейсов пробелов
        // нет, так что фильтру он не нужен. Проверка идёт до ветки печатных символов.
        if (name === 'space' || chunk === ' ') {
            this.toggleRunMode();
            return true;
        }
        if (CONFIRM_KEYS.has(name)) {
            const service = this.selectedService();
            if (service) {
                const mode = this.runMode();
                this.app.launch({
                    command: this.services.command,
                    workspace: service.rel,
                    runMode: mode.value === 'watch' ? 'watch' : 'default',
                    foreground: mode.value === 'foreground',
                });
            }
            return true;
        }
        if (name === 'backspace') {
            if (this.services.filter.length > 0) {
                this.services.filter = this.services.filter.slice(0, -1);
                this.render();
                return true;
            }
            this.focus = 'side';
            this.render();
            return true;
        }
        // Буквы здесь уходят в фильтр, значит "q" не выходит из программы. Escape —
        // штатный выход из колонки, Ctrl+C по-прежнему работает на верхнем уровне.
        if (name === 'escape') {
            this.services.filter = '';
            this.focus = 'side';
            this.render();
            return true;
        }
        if (!key?.ctrl && !key?.meta && typeof chunk === 'string' && chunk.length === 1 && chunk >= ' ') {
            this.services.filter += chunk;
            // Выбор не сбрасываем: если отфильтрованный список всё ещё содержит
            // выбранный сервис, курсор остаётся на нём.
            this.render();
            return true;
        }
        return false;
    }

    hotkeys() {
        const context = this.rightContext();
        if (this.focus === 'right' && context === 'services') {
            return 'печатай фильтр  ↑↓ сервис  Пробел режим  Enter запуск  Tab/←/Esc назад  Ctrl+C выход';
        }
        if (this.focus === 'right' && context === 'containers') {
            return 'печатай фильтр  ↑↓ контейнер  Enter действия  Tab/←/Esc назад  Ctrl+C выход';
        }
        if (this.focus === 'right' && context === 'jobs') {
            return '↑↓ джоба  Enter трасса  ←/Esc назад  r обновить  q выход';
        }
        if (context === 'trace') {
            return '↑↓ PgUp/PgDn скролл  / поиск  y копировать  z на весь экран  t время  ←/Esc назад';
        }
        return 'Tab/←→ колонки  Enter выбрать  Пробел режим  y копировать  z весь экран  p пайплайн  s стоп  S стоп все  d забыть  i детали  t время  / поиск  r обновить  ? помощь  q выход';
    }
}

/**
 * Список поверх экрана: меню действий и каталог образов. Именно вид, а не колонка —
 * это разовый выбор, а не постоянное содержимое. Буквенных хоткеев внутри нет:
 * при filterable они уходят в фильтр, иначе игнорируются.
 */
class MenuView extends View {
    constructor(app, { title, items, onPick, hint = '', filterable = false }) {
        super(app);
        this.title = title;
        this.items = items;
        this.onPick = onPick;
        this.hint = hint;
        this.filterable = filterable;
        this.filter = '';
        this.cursor = 0;
    }

    mount() {
        this.box = this.app.blessed.box({
            parent: this.app.body,
            top: 'center',
            left: 'center',
            width: '80%',
            height: '80%',
            border: 'line',
            label: ` ${this.title} `,
            tags: true,
            scrollable: true,
            alwaysScroll: true,
            padding: { left: 1, right: 1 },
        });
        this.widgets = [this.box];
        this.render();
    }

    visible() {
        if (!this.filterable || !this.filter) {
            return this.items;
        }
        const needle = this.filter.toLowerCase();
        return this.items.filter((item) => item.label.toLowerCase().includes(needle));
    }

    render() {
        const rows = this.visible();
        this.cursor = Math.min(this.cursor, Math.max(0, rows.length - 1));
        const head = this.filterable
            ? `Фильтр: ${this.filter || '{grey-fg}(пусто){/}'}\n\n`
            : '';
        const body =
            rows.length === 0
                ? '{grey-fg}Ничего не найдено.{/}'
                : rows
                      .map((item, position) =>
                          position === this.cursor
                              ? `{inverse}${stripTags(item.label)}{/}`
                              : item.label
                      )
                      .join('\n');
        this.box.setContent(`${head}${body}`);
        this.box.scrollTo(this.cursor);
    }

    handleKey(chunk, key) {
        const name = key?.name;
        if (name === 'up' || name === 'down') {
            const limit = this.visible().length - 1;
            this.cursor = Math.max(0, Math.min(limit, this.cursor + (name === 'down' ? 1 : -1)));
            this.render();
            return true;
        }
        if (CONFIRM_KEYS.has(name)) {
            const picked = this.visible()[this.cursor];
            if (picked) {
                this.onPick(picked.value);
            }
            return true;
        }
        if (name === 'backspace' && this.filterable && this.filter.length > 0) {
            this.filter = this.filter.slice(0, -1);
            this.render();
            return true;
        }
        if (
            this.filterable &&
            !key?.ctrl &&
            !key?.meta &&
            typeof chunk === 'string' &&
            chunk.length === 1 &&
            chunk >= ' '
        ) {
            this.filter += chunk;
            this.render();
            return true;
        }
        return false;
    }

    hotkeys() {
        return this.hint || '↑↓ выбор  Enter выполнить  Backspace назад';
    }
}

class TaskDetailsView extends View {
    constructor(app, task) {
        super(app);
        this.task = task;
        this.title = `Задача ${task.id}`;
    }

    mount() {
        this.box = this.app.blessed.box({
            parent: this.app.body,
            top: 'center',
            left: 'center',
            width: '70%',
            height: 16,
            border: 'line',
            label: ` ${this.title} `,
            tags: true,
        });
        this.widgets = [this.box];
        const task = this.task;
        this.box.setContent(
            [
                `ID:         ${task.id}`,
                `Статус:     ${task.status}`,
                `Команда:    ${task.spec.label()}`,
                `PID:        ${task.pid ?? '-'}`,
                `Старт:      ${new Date(task.createdAt).toLocaleString()}`,
                `Финиш:      ${task.stoppedAt ? new Date(task.stoppedAt).toLocaleString() : '-'}`,
                `Время:      ${task.runtime()}`,
                `Код:        ${task.exitCode ?? '-'}`,
                `Сигнал:     ${task.signal ?? '-'}`,
                `Строк лога: ${task.log.size}`,
            ].join('\n')
        );
    }

    hotkeys() {
        return 'Backspace назад';
    }
}

class HelpView extends View {
    constructor(app) {
        super(app);
        this.title = 'Хоткеи';
    }

    mount() {
        this.box = this.app.blessed.box({
            parent: this.app.body,
            top: 'center',
            left: 'center',
            width: '70%',
            height: 20,
            border: 'line',
            label: ' Хоткеи ',
            tags: true,
        });
        this.widgets = [this.box];
        this.box.setContent(
            [
                '↑ ↓          курсор в списке или скролл лога',
                'Tab  ← →     переключить колонку',
                'Enter        команда — уйти к её сервисам, задача — фокус в лог',
                'Пробел       режим: Обычный → Watch → В терминале',
                'В колонке сервисов: буквы — фильтр, Enter — запуск, Esc — назад',
                'p            запустить пайплайн на текущей ветке (спросит подтверждение)',
                's            на пайплайне — отменить его',
                'Enter        на пайплайне — джобы, на джобе — её трасса',
                'n / N        следующее и предыдущее совпадение поиска',
                's / S        остановить выбранную / все',
                'd            забыть завершённую задачу',
                'i            детали задачи',
                't            показать или скрыть таймстемпы',
                'y            скопировать лог или трассу в буфер обмена',
                'z            лог на весь экран без рамок — чтобы выделять мышью',
                '/            поиск по логу, Escape — снять',
                'PgUp / PgDn  история лога, Home / End — начало и конец',
                'r            пересканировать воркспейсы',
                'Backspace    назад',
                'q / Ctrl+C   выход',
                '',
                'Docker Compose:',
                '  Enter на контейнере — меню: логи, обновить, образы и откат, рестарт, стоп',
                '  первая строка списка — операции над всем проектом',
                '  буквы фильтруют список, всё меняющее состояние спрашивает подтверждение',

            ].join('\n')
        );
    }

    hotkeys() {
        return 'Backspace назад';
    }
}

class ConfirmView extends View {
    constructor(app, { title, text, onConfirm }) {
        super(app);
        this.title = title;
        this.text = text;
        this.onConfirm = onConfirm;
    }

    mount() {
        this.box = this.app.blessed.box({
            parent: this.app.body,
            top: 'center',
            left: 'center',
            width: '60%',
            height: 8,
            border: 'line',
            label: ` ${this.title} `,
            tags: true,
        });
        this.widgets = [this.box];
        this.box.setContent(`${this.text}\n\n{green-fg}y{/} — да    {red-fg}n{/} — отмена`);
    }

    handleKey(chunk, key) {
        const name = key?.name;
        if (name === 'y' || CONFIRM_KEYS.has(name)) {
            this.onConfirm();
            return true;
        }
        if (name === 'n' || name === 'escape') {
            this.app.pop();
            return true;
        }
        return false;
    }

    hotkeys() {
        return 'y подтвердить  n отмена';
    }
}

class TuiApp {
    constructor({
        repoRoot,
        blessedImpl = null,
        tickMs = TICK_MS,
        pipelines = null,
        roots = null,
        clipboardImpl = null,
        compose = null,
        imageCatalogImpl = null,
    }) {
        this.clipboard = clipboardImpl ?? ((text) => copyToClipboard(text));
        this.notice = null;
        this.repoRoot = repoRoot;
        this.blessed = blessedImpl ?? require('blessed');
        this.tickMs = tickMs;
        this.index = new WorkspaceIndex({ repoRoot, roots: roots ?? workspaceRoots(repoRoot) });
        this.index.refresh();
        this.manager = new TaskManager({ repoRoot });
        this.pipelines = pipelines ?? createPipelineStore({ repoRoot });
        this.compose = compose ?? createComposeStore({ startDir: repoRoot });
        // Каталог нужен только при живом compose; реестр подставляется на вызов.
        this.imageCatalog =
            imageCatalogImpl ??
            (this.compose.isEnabled()
                ? new ImageCatalog({ cli: this.compose.cli, runner: this.compose.runner })
                : null);
        this.screen = null;
        this.stack = null;
        this.timer = null;
    }

    run() {
        this.screen = this.blessed.screen({
            smartCSR: true,
            mouse: false,
            title: 'task-runner',
        });
        this.body = this.blessed.box({
            parent: this.screen,
            top: 0,
            left: 0,
            right: 0,
            bottom: 1,
        });
        this.statusBar = this.blessed.box({
            parent: this.screen,
            bottom: 0,
            height: 1,
            left: 0,
            right: 0,
            tags: true,
        });
        this.stack = new NavigationStack(new HomeView(this));
        this.stack.top().mount();
        this.manager.on('changed', () => this.renderStatus());
        this.compose.on('changed', () => {
            const view = this.stack.top();
            if (view instanceof HomeView) {
                view.model.rebuild();
                view.render();
            }
            this.render();
        });
        this.pipelines.on('changed', () => {
            const view = this.stack.top();
            if (view instanceof HomeView) {
                view.model.rebuild();
                view.render();
            }
            this.render();
        });
        this.screen.on('resize', () => this.render());
        this.screen.on('keypress', (chunk, key) => this.onKey(chunk, key));
        this.ticks = 0;
        this.timer = setInterval(() => this.onTick(), this.tickMs);
        void this.pipelines.refresh();
        void this.compose.refresh();
        this.render();
    }

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
        // Контейнеры — раз в 5 с и только пока курсор стоит на секции compose.
        if (this.ticks % every(5000) === 0 && this.compose.isEnabled()) {
            const view = this.stack.top();
            if (view instanceof HomeView && view.model.selected()?.kind === 'compose') {
                void this.compose.refresh();
            }
        }
    }

    push(view) {
        this.stack.top().unmount();
        this.stack.push(view);
        view.mount();
        this.render();
    }

    pop() {
        const popped = this.stack.pop();
        if (!popped) {
            return false;
        }
        popped.unmount();
        this.stack.top().mount();
        this.render();
        return true;
    }

    render() {
        this.renderStatus();
        this.screen.render();
    }

    renderStatus() {
        const { running, done, failed } = this.manager.counters();
        const left = `{green-fg}Запущено: ${running}{/}  Готово: ${done}  {red-fg}Ошибок: ${failed}{/}`;
        const right = this.notice ? `{yellow-fg}${this.notice}{/}` : this.stack.top().hotkeys();
        this.statusBar.setContent(`${left} │ ${right}`);
    }

    /** Разовое сообщение в статус-баре — до следующего нажатия клавиши. */
    notify(text) {
        this.notice = text;
        this.renderStatus();
        this.screen.render();
    }

    suspend(action) {
        this.screen.leave();
        const result = action();
        this.screen.enter();
        this.screen.realloc();
        this.render();
        return result;
    }

    launch({ command, workspace, runMode, foreground }) {
        this.index.markCommandUsed(command);
        if (foreground) {
            return this.suspend(() => {
                const status = this.manager.runForeground({ command, workspace, runMode });
                process.stdout.write(`\nКоманда завершилась с кодом ${status}.\n`);
                return status;
            });
        }
        this.manager.start({ command, workspace, runMode });
        // Курсор не трогаем: после запуска остаёмся там же, где были, чтобы можно
        // было запустить ещё пару сервисов подряд.
        const home = this.stack.top();
        if (home instanceof HomeView) {
            home.model.rebuild();
            home.render();
        }
        this.render();
        return 0;
    }

    onKey(chunk, key) {
        const name = key?.name;
        // Сообщение живёт до следующей клавиши: гасим прежнее перед обработкой,
        // чтобы новое, выставленное этим же нажатием, осталось видно.
        this.notice = null;
        // blessed на "\r" пере-эмитит тот же keypress под именем "enter"
        // (program.js:397-399), причём из-за вложенности синтетическое событие
        // доходит сюда РАНЬШЕ настоящего "return". Без этой отбивки один Enter
        // срабатывает дважды: открывает вид и сразу «нажимает» в нём первую строку.
        // Отличаем дубль по последовательности: у него sequence === '\r'.
        if (name === 'enter' && key?.sequence === '\r') {
            return;
        }
        if (this.stack.top().handleKey(chunk, key)) {
            // Не только screen.render(): статус-бар держит подсказки контекста,
            // счётчики и разовые сообщения — их тоже надо обновить.
            this.render();
            return;
        }
        if (name === 'backspace') {
            this.pop();
            return;
        }
        if (name === 'q' || (key?.ctrl && name === 'c')) {
            this.requestQuit();
        }
    }

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
            new MenuView(this, {
                title: `Образы ${service}`,
                hint: 'печатай фильтр  ↑↓ выбор  Enter откатить  Backspace назад',
                filterable: true,
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
                'После отката локальный тег разойдётся с реестром: следующее «Обновить»',
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

    /** Запуск пайплайна — запись в GitLab, поэтому только через подтверждение. */
    requestPipelineRun() {
        const store = this.pipelines;
        if (!store?.isEnabled()) {
            return;
        }
        this.push(
            new ConfirmView(this, {
                title: 'Запуск пайплайна',
                text: `Запустить пайплайн на ветке "${store.ref}"?`,
                onConfirm: () => {
                    this.pop();
                    void store.trigger();
                },
            })
        );
    }

    requestPipelineCancel(pipeline) {
        const store = this.pipelines;
        if (!store?.isEnabled() || pipeline.status !== 'running') {
            return;
        }
        this.push(
            new ConfirmView(this, {
                title: 'Отмена пайплайна',
                text: `Отменить пайплайн #${pipeline.id}?`,
                onConfirm: () => {
                    this.pop();
                    void store.cancel(pipeline.id);
                },
            })
        );
    }

    requestQuit() {
        const running = this.manager.runningCount();
        if (running === 0) {
            this.quit(0);
            return;
        }
        this.push(
            new ConfirmView(this, {
                title: 'Выход',
                text: `Запущено задач: ${running}. Остановить их и выйти?`,
                onConfirm: () => {
                    this.manager.stopAll();
                    this.quit(0);
                },
            })
        );
    }

    quit(code = 0) {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.screen.destroy();
        process.exit(code);
    }
}

module.exports = {
    DockerCli,
    DockerRunner,
    ComposeProject,
    COMPOSE_FILENAMES,
    parsePsOutput,
    parseImagesOutput,
    parseDockerDate,
    ComposeStore,
    createComposeStore,
    ComposeRegistry,
    ProjectIndex,
    MAKEFILE_NAMES,
    MakefileTargets,
    MakeCommand,
    ShellCommand,
    projectRunnables,
    DockerCommand,
    CommandSequence,
    RegistryLookup,
    ImageCatalog,
    imageReferenceForService,
    rollbackTargets,
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
    GitLabClient,
    PipelineStore,
    parseGitLabRemote,
    createPipelineStore,
    gitlabIcon,
    View,
    HomeView,
    TaskDetailsView,
    HelpView,
    ConfirmView,
    MenuView,
    TuiApp,
    assertTerminal,
    selfCheck,
    findProjectRoot,
    workspaceRoots,
    readJsonFile,
};
