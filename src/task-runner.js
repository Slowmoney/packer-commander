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

    spawnTarget() {
        const args = this.args();
        if (this.npmExecPath && this.exists(this.npmExecPath)) {
            return { command: this.nodePath, args: [this.npmExecPath, ...args] };
        }
        if (this.platform === 'win32') {
            return { command: 'npm.cmd', args };
        }
        return { command: 'npm', args };
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

const TERMINAL_STATUSES = new Set(['finished', 'failed', 'stopped']);

/**
 * Одна запущенная команда. Статус берётся из событий процесса, а не из
 * process.kill(pid, 0): pid переиспользуются, и такая проверка врёт.
 */
class Task extends EventEmitter {
    constructor({
        id,
        npmCommand,
        now = () => Date.now(),
        killTimeoutMs = KILL_TIMEOUT_MS,
        setTimeoutImpl = setTimeout,
        clearTimeoutImpl = clearTimeout,
        logLimit = LOG_LIMIT,
    }) {
        super();
        this.id = id;
        this.npmCommand = npmCommand;
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
        this.log = new LogBuffer({ limit: logLimit });
    }

    get workspace() {
        return this.npmCommand.workspace;
    }

    get command() {
        return this.npmCommand.command;
    }

    get runMode() {
        return this.npmCommand.runMode;
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
            this.#transition(code === 0 ? 'finished' : 'failed');
        });
    }

    stop() {
        if (!this.isRunning()) {
            return;
        }
        try {
            this.child?.kill('SIGTERM');
        } catch (error) {
            this.#write(`stop failed: ${error.message}\n`, 'stderr');
        }
        this.#write('stop requested by user\n', 'stdout');
        this.killTimer = this.setTimeoutImpl(() => {
            try {
                this.child?.kill('SIGKILL');
            } catch {
                // процесс уже умер — добивать нечего
            }
        }, this.killTimeoutMs);
        this.#transition('stopped');
    }

    runtime(nowMs = this.now()) {
        const end = this.stoppedAt ?? nowMs;
        const totalSeconds = Math.max(0, Math.floor((end - this.createdAt) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        return `${minutes}:${seconds}`;
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
    }) {
        super();
        this.repoRoot = repoRoot;
        this.spawnImpl = spawnImpl;
        this.spawnSyncImpl = spawnSyncImpl;
        this.idFactory = idFactory;
        this.taskOptions = taskOptions;
        /** @type {Task[]} */
        this.items = [];
    }

    start({ command, workspace, runMode = 'default' }) {
        const npmCommand = new NpmCommand({ command, workspace, runMode });
        const task = new Task({ id: this.idFactory(), npmCommand, ...this.taskOptions });
        const target = npmCommand.spawnTarget();
        const child = this.spawnImpl(target.command, target.args, {
            cwd: this.repoRoot,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
        });
        task.attach(child);
        task.on('status', () => this.emit('changed'));
        this.items.push(task);
        this.emit('changed');
        return task;
    }

    runForeground({ command, workspace, runMode = 'default' }) {
        const npmCommand = new NpmCommand({ command, workspace, runMode });
        const target = npmCommand.spawnTarget();
        const result = this.spawnSyncImpl(target.command, target.args, {
            cwd: this.repoRoot,
            stdio: 'inherit',
            shell: false,
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
    constructor({ index, manager, pipelines = null }) {
        this.index = index;
        this.manager = manager;
        this.pipelines = pipelines;
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
        // Правая колонка одна и меняется по контексту левой: на команде — её сервисы,
        // на задаче — её лог.
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

        const context = this.rightContext();
        if (context === 'services') {
            this.renderServices();
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
        this.side.style.border = { fg: this.focus === 'side' ? 'cyan' : 'white' };
        this.right.style.border = { fg: this.focus === 'right' ? 'cyan' : 'white' };
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
            task ? ` Лог: ${task.npmCommand.label()} ${searchSuffix}` : ` Лог ${searchSuffix}`
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
        if (this.focus === 'right' && context === 'jobs') {
            return '↑↓ джоба  Enter трасса  ←/Esc назад  r обновить  q выход';
        }
        if (context === 'trace') {
            return '↑↓ PgUp/PgDn скролл  / поиск  t время  ←/Esc назад  q выход';
        }
        return 'Tab/←→ колонки  Enter выбрать  Пробел режим  p пайплайн  s стоп  S стоп все  d забыть  i детали  t время  / поиск  r обновить  ? помощь  q выход';
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
                `Команда:    ${task.npmCommand.label()}`,
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
                '/            поиск по логу, Escape — снять',
                'PgUp / PgDn  история лога, Home / End — начало и конец',
                'r            пересканировать воркспейсы',
                'Backspace    назад',
                'q / Ctrl+C   выход',
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
    constructor({ repoRoot, blessedImpl = null, tickMs = TICK_MS, pipelines = null, roots = null }) {
        this.repoRoot = repoRoot;
        this.blessed = blessedImpl ?? require('blessed');
        this.tickMs = tickMs;
        this.index = new WorkspaceIndex({ repoRoot, roots: roots ?? workspaceRoots(repoRoot) });
        this.index.refresh();
        this.manager = new TaskManager({ repoRoot });
        this.pipelines = pipelines ?? createPipelineStore({ repoRoot });
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
        this.timer = setInterval(() => {
            this.stack.top().tick();
            this.renderStatus();
            this.screen.render();
            // Пайплайны опрашиваем раз в 30 с и только пока что-то бежит.
            this.ticks += 1;
            if (this.ticks % Math.max(1, Math.round(30_000 / this.tickMs)) === 0) {
                if (this.pipelines.hasRunning()) {
                    void this.pipelines.refresh();
                }
            }
        }, this.tickMs);
        void this.pipelines.refresh();
        this.render();
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
        this.statusBar.setContent(`${left} │ ${this.stack.top().hotkeys()}`);
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
        // blessed на "\r" пере-эмитит тот же keypress под именем "enter"
        // (program.js:397-399), причём из-за вложенности синтетическое событие
        // доходит сюда РАНЬШЕ настоящего "return". Без этой отбивки один Enter
        // срабатывает дважды: открывает вид и сразу «нажимает» в нём первую строку.
        // Отличаем дубль по последовательности: у него sequence === '\r'.
        if (name === 'enter' && key?.sequence === '\r') {
            return;
        }
        if (this.stack.top().handleKey(chunk, key)) {
            this.screen.render();
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
    WorkspaceIndex,
    NpmCommand,
    AnsiTags,
    LogBuffer,
    Task,
    TaskManager,
    SidePanelModel,
    NavigationStack,
    SearchState,
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
    TuiApp,
    assertTerminal,
    selfCheck,
    findProjectRoot,
    workspaceRoots,
    readJsonFile,
};
