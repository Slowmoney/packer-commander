// Дымовые прогоны UI на заглушке blessed: настоящий терминал не нужен.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
    TuiApp,
    TaskManager,
    HomeView,
    HelpView,
    ConfirmView,
    PipelineStore,
} = require('../src/task-runner.js');

function widget(options = {}) {
    return {
        options,
        content: '',
        label: '',
        height: 10,
        style: {},
        scrolledTo: null,
        setContent(text) {
            this.content = text;
        },
        setLabel(text) {
            this.label = text;
        },
        detach() {
            this.detached = true;
        },
        scroll(delta) {
            this.scrolledTo = Math.max(0, (this.scrolledTo ?? 0) + delta);
        },
        setScrollPerc() {},
        scrollTo(line) {
            this.scrolledTo = line;
        },
        getScroll() {
            return this.scrolledTo ?? 0;
        },
    };
}

function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ui-'));
    fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['apps/*'] })
    );
    for (const name of ['api', 'payment', 'webhooks']) {
        const dir = path.join(root, 'apps', name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: `demo-${name}`, scripts: { build: 'tsc', serve: 'node .' } })
        );
    }
    return root;
}

function fakeChild(pid = 777) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = [];
    child.kill = (signal) => child.killed.push(signal);
    return child;
}

function gitlabStub(calls) {
    return {
        pipelines: async () => [
            { id: 5, status: 'running' },
            { id: 4, status: 'failed' },
        ],
        jobs: async (id) => {
            calls.push(`jobs:${id}`);
            return [
                { id: 50, name: 'build-api', stage: 'build', status: 'failed', duration: 12.4 },
                { id: 51, name: 'test-api', stage: 'test', status: 'success', duration: 30 },
            ];
        },
        trace: async (id) => {
            calls.push(`trace:${id}`);
            return 'installing\n\x1b[31merror TS2345: boom\x1b[0m\nexit 1';
        },
        createPipeline: async (ref) => {
            calls.push(`create:${ref}`);
            return { id: 6 };
        },
        cancelPipeline: async (id) => {
            calls.push(`cancel:${id}`);
            return {};
        },
    };
}

function bootstrap(extra = {}) {
    const screen = new EventEmitter();
    screen.render = () => {};
    screen.destroy = () => {};
    screen.leave = () => {
        screen.left = true;
    };
    screen.enter = () => {
        screen.entered = true;
    };
    screen.realloc = () => {};

    const gitlabCalls = [];
    const pipelines = new PipelineStore({ ref: 'master', client: gitlabStub(gitlabCalls) });
    const repoRoot = makeRepo();
    const app = new TuiApp({
        repoRoot,
        blessedImpl: { screen: () => screen, box: (options) => widget(options) },
        tickMs: 100_000,
        pipelines,
        ...extra,
    });
    const children = [];
    app.manager = new TaskManager({
        repoRoot,
        spawnImpl: () => {
            const child = fakeChild(1000 + children.length);
            children.push(child);
            return child;
        },
        spawnSyncImpl: () => ({ status: 0 }),
        idFactory: () => `t${children.length + 1}`,
    });
    app.run();

    const press = (chunk, name, extra = {}) => screen.emit('keypress', chunk, { name, ...extra });
    // Настоящий порядок blessed на один Enter (blessed/lib/program.js): сначала
    // синтетический "enter" с sequence "\r", потом реальный "return".
    const pressEnter = () => {
        press('\r', 'enter', { sequence: '\r' });
        press('\r', 'return', { sequence: '\r' });
    };
    const type = (text) => {
        for (const char of text) {
            press(char, char);
        }
    };
    const home = app.stack.top();
    const cleanup = () => clearInterval(app.timer);

    return { app, home, screen, press, pressEnter, type, children, gitlabCalls, pipelines, cleanup };
}

test('дом: две колонки с отступом от рамок, справа сервисы выбранной команды', () => {
    const { app, home, cleanup } = bootstrap();
    try {
        assert.equal(home.widgets.length, 2, 'ровно две колонки');
        assert.equal(home.rightContext(), 'services');
        assert.match(home.right.label, /build • режим: Обычный/);
        assert.match(home.right.content, /apps\/payment/);
        assert.equal(app.stack.depth, 1, 'никаких модалок');
    } finally {
        cleanup();
    }
});

test('левая колонка прокручивается за курсором, а не обрезает нижние элементы', () => {
    const { home, press, cleanup } = bootstrap();
    try {
        assert.equal(home.side.scrolledTo, 1, 'старт на первой выбираемой строке');
        for (let step = 0; step < 5; step += 1) {
            press(null, 'down');
        }
        const rows = home.model.rows();
        const cursor = home.model.cursorRowIndex();
        assert.equal(home.side.scrolledTo, cursor, 'прокрутка следует за курсором');
        assert.ok(cursor > 1 && cursor < rows.length);
    } finally {
        cleanup();
    }
});

test('один Enter уводит фокус вправо и ничего не запускает', () => {
    const { app, home, pressEnter, cleanup } = bootstrap();
    try {
        pressEnter();
        assert.equal(home.focus, 'right');
        assert.equal(app.stack.depth, 1);
        assert.equal(app.manager.tasks().length, 0);
    } finally {
        cleanup();
    }
});

test('буквы фильтруют сервисы, включая "w"; запуск по Enter', () => {
    const { app, home, pressEnter, type, cleanup } = bootstrap();
    try {
        pressEnter();
        type('web');
        assert.equal(home.services.filter, 'web');
        assert.deepEqual(
            home.visibleServices().map((pkg) => pkg.rel),
            ['apps/webhooks']
        );
        assert.equal(app.manager.tasks().length, 0, 'фильтр ничего не запускает');

        pressEnter();
        assert.equal(app.manager.tasks().length, 1);
        assert.equal(app.manager.tasks()[0].workspace, 'apps/webhooks');
        assert.equal(home.rightContext(), 'services', 'остались в списке сервисов');
    } finally {
        cleanup();
    }
});

test('пробел крутит режим запуска по кругу', () => {
    const { home, press, cleanup } = bootstrap();
    try {
        press(' ', 'space');
        assert.match(home.right.label, /режим: Watch/);
        press(' ', 'space');
        assert.match(home.right.label, /режим: В терминале/);
        press(' ', 'space');
        assert.match(home.right.label, /режим: Обычный/);
    } finally {
        cleanup();
    }
});

test('переход с лога на команду показывает сервисы сразу', () => {
    const { app, home, pressEnter, type, press, cleanup } = bootstrap();
    try {
        pressEnter();
        type('pay');
        pressEnter();
        const task = app.manager.tasks()[0];

        press(null, 'left');
        home.model.selectKey(`task:${task.id}`);
        home.render();
        assert.equal(home.rightContext(), 'log');

        home.model.selectKey('command:serve');
        home.render();
        assert.equal(home.rightContext(), 'services');
        assert.match(home.right.label, /serve • режим/);
        assert.match(home.right.content, /apps\/api/, 'список не пустой сразу');
    } finally {
        cleanup();
    }
});

test('каждая команда помнит свой фильтр и режим запуска', () => {
    const { home, press, pressEnter, type, cleanup } = bootstrap();
    try {
        // build: фильтр "pay" и режим Watch.
        pressEnter();
        type('pay');
        press(' ', 'space');
        assert.equal(home.services.filter, 'pay');
        assert.match(home.right.label, /build • режим: Watch/);

        // Уходим на serve — там своё чистое состояние, но режим наследуется.
        press(null, 'left');
        home.model.selectKey('command:serve');
        home.render();
        assert.equal(home.services.filter, '', 'у новой команды свой фильтр');
        assert.match(home.right.label, /serve • режим: Watch/, 'режим наследуется новым пунктом');
        home.press = press;
        press(null, 'right');
        type('api');
        press(' ', 'space');
        assert.equal(home.services.filter, 'api');
        assert.match(home.right.label, /serve • режим: В терминале/);

        // Возврат на build: всё как оставили.
        press(null, 'left');
        home.model.selectKey('command:build');
        home.render();
        assert.equal(home.services.filter, 'pay', 'фильтр build восстановлен');
        assert.match(home.right.label, /build • режим: Watch/, 'режим build восстановлен');

        // И обратно на serve.
        home.model.selectKey('command:serve');
        home.render();
        assert.equal(home.services.filter, 'api', 'фильтр serve восстановлен');
        assert.match(home.right.label, /serve • режим: В терминале/);
    } finally {
        cleanup();
    }
});

test('задача помнит свой поиск, автоскролл и позицию прокрутки', () => {
    const { app, home, press, pressEnter, type, children, cleanup } = bootstrap();
    try {
        pressEnter();
        pressEnter();
        pressEnter();
        press(null, 'left');
        const [first, second] = app.manager.tasks();
        children[0].stdout.emit('data', 'alpha\nerror one\nbeta\n');
        children[1].stdout.emit('data', 'gamma\nerror two\ndelta\n');

        // На первой задаче: поиск и уход от конца лога.
        home.model.selectKey(`task:${first.id}`);
        home.render();
        press('/', 'slash');
        type('error');
        assert.equal(home.search.active, true);
        assert.deepEqual(home.search.matches, [1]);
        press(null, 'pageup');
        assert.equal(home.autoScroll, false, 'ушли от конца лога');
        const scrollOnFirst = home.right.getScroll();

        // Вторая задача — своё состояние: поиска нет, автоскролл включён.
        home.model.selectKey(`task:${second.id}`);
        home.render();
        assert.equal(home.search.active, false, 'у второй задачи свой поиск');
        assert.equal(home.autoScroll, true, 'и свой автоскролл');

        // Возврат к первой: поиск и прокрутка на месте.
        home.model.selectKey(`task:${first.id}`);
        home.render();
        assert.equal(home.search.active, true, 'поиск восстановлен');
        assert.equal(home.search.pattern, 'error');
        assert.equal(home.autoScroll, false, 'автоскролл остался выключенным');
        assert.equal(home.right.getScroll(), scrollOnFirst, 'позиция прокрутки восстановлена');
    } finally {
        cleanup();
    }
});

test('пайплайн помнит курсор джобы и открытую трассу', async () => {
    const { home, press, pressEnter, pipelines, cleanup } = bootstrap();
    try {
        await pipelines.refresh();
        home.model.rebuild();
        home.model.selectKey('pipeline:5');
        home.render();

        pressEnter();
        await new Promise(setImmediate);
        press(null, 'down');
        assert.equal(home.jobCursor(), 1, 'курсор на второй джобе');
        assert.equal(home.jobs.selectedJobId, 51, 'выбор хранится id, а не индексом');
        pressEnter();
        await new Promise(setImmediate);
        await new Promise(setImmediate);
        assert.equal(home.rightContext(), 'trace');

        // Уходим на другой пайплайн курсором слева, не закрывая трассу через ←.
        home.model.selectKey('pipeline:4');
        home.render();
        assert.equal(home.rightContext(), 'jobs', 'у другого пайплайна трасса не открыта');
        assert.equal(home.jobCursor(), 0, 'и свой курсор джоб');

        home.model.selectKey('pipeline:5');
        home.render();
        assert.equal(home.rightContext(), 'trace', 'трасса вернулась');
        assert.equal(home.jobCursor(), 1, 'курсор джобы восстановлен');
        assert.match(home.right.label, /test-api/, 'та же джоба');
    } finally {
        cleanup();
    }
});

test('поиск по логу подсвечивает совпадения', () => {
    const { app, home, pressEnter, type, press, children, cleanup } = bootstrap();
    try {
        pressEnter();
        pressEnter();
        const task = app.manager.tasks()[0];
        children[0].stdout.emit('data', 'compiling\nsrc/app.ts(4,1): error TS2345\ndone\n');
        press(null, 'left');
        home.model.selectKey(`task:${task.id}`);
        home.render();

        press('/', 'slash');
        type('error');
        assert.deepEqual(home.search.matches, [1]);
        assert.match(home.right.content, /yellow-bg/);
        press(null, 'escape');
        assert.equal(home.search.active, false);
    } finally {
        cleanup();
    }
});

test('z разворачивает лог на весь экран без рамок и меню', () => {
    const { app, home, pressEnter, press, children, cleanup } = bootstrap();
    try {
        pressEnter();
        pressEnter();
        const task = app.manager.tasks()[0];
        children[0].stdout.emit('data', 'alpha\nbeta\n');
        press(null, 'left');
        home.model.selectKey(`task:${task.id}`);
        home.render();
        assert.equal(home.widgets.length, 2, 'обычно две колонки');

        press('z', 'z');
        assert.equal(home.zoom, true);
        assert.equal(home.widgets.length, 1, 'в зуме одна колонка');
        assert.equal(home.side, null, 'левого меню нет — выделять мышью нечего лишнего');
        assert.equal(home.right.options.border, undefined, 'без рамки');
        assert.match(home.right.content, /alpha/, 'лог на месте');

        press('z', 'z');
        assert.equal(home.zoom, false);
        assert.equal(home.widgets.length, 2, 'колонки вернулись');
        assert.match(home.side.content, /Команды/);
    } finally {
        cleanup();
    }
});

test('y копирует лог без разметки и сообщает об этом', () => {
    const copied = [];
    const { app, home, pressEnter, press, children, cleanup } = bootstrap({
        clipboardImpl: (text) => {
            copied.push(text);
            return 'системный буфер';
        },
    });
    try {
        pressEnter();
        pressEnter();
        const task = app.manager.tasks()[0];
        children[0].stdout.emit('data', 'plain line\n\x1b[31mred error\x1b[0m\n');
        press(null, 'left');
        home.model.selectKey(`task:${task.id}`);
        home.render();

        press('y', 'y');

        assert.equal(copied.length, 1);
        assert.equal(copied[0], 'plain line\nred error', 'ни тегов blessed, ни ANSI');
        assert.match(app.statusBar.content, /Скопировано строк: 2/);
        assert.match(app.statusBar.content, /системный буфер/);

        // Сообщение живёт до следующей клавиши.
        press(null, 'down');
        assert.doesNotMatch(app.statusBar.content, /Скопировано/);
    } finally {
        cleanup();
    }
});

test('y на команде честно говорит, что копировать нечего', () => {
    const { app, press, cleanup } = bootstrap({ clipboardImpl: () => 'буфер' });
    try {
        press('y', 'y');
        assert.match(app.statusBar.content, /Копировать нечего/);
    } finally {
        cleanup();
    }
});

test('выход при живой задаче спрашивает подтверждение', () => {
    const { app, home, pressEnter, press, cleanup } = bootstrap();
    try {
        pressEnter();
        pressEnter();
        assert.equal(app.manager.runningCount(), 1);
        app.quit = (code) => {
            app.quitCode = code;
        };

        // В колонке сервисов буквы — фильтр, поэтому "q" туда и уходит, а выход
        // остаётся на Ctrl+C (так написано в подсказке этого контекста).
        press('q', 'q');
        assert.equal(home.services.filter, 'q', '"q" попал в фильтр, а не вышел');
        assert.equal(app.stack.depth, 1, 'подтверждение не открылось');
        press('\x03', 'c', { ctrl: true });
        assert.ok(app.stack.top() instanceof ConfirmView, 'Ctrl+C спросил подтверждение');
        press(null, 'n');
        assert.equal(app.quitCode, undefined, 'отмена не выходит');

        // Слева "q" работает как выход.
        press(null, 'left');

        press('q', 'q');
        press(null, 'y');
        assert.equal(app.quitCode, 0);
        assert.equal(app.manager.runningCount(), 0, 'задачи остановлены');
        assert.ok(home instanceof HomeView);
    } finally {
        cleanup();
    }
});

test('помощь открывается и снимается backspace', () => {
    const { app, press, cleanup } = bootstrap();
    try {
        press('?', '?');
        assert.ok(app.stack.top() instanceof HelpView);
        press(null, 'backspace');
        assert.ok(app.stack.top() instanceof HomeView);
    } finally {
        cleanup();
    }
});

test('пайплайны: секция, джобы, трасса с ANSI и поиск по ней', async () => {
    const { home, pressEnter, press, type, pipelines, gitlabCalls, cleanup } = bootstrap();
    try {
        await pipelines.refresh();
        home.model.rebuild();
        home.render();
        assert.match(home.side.content, /Пайплайны master \(2\)/);

        home.model.selectKey('pipeline:5');
        home.render();
        assert.equal(home.rightContext(), 'jobs');

        pressEnter();
        await new Promise(setImmediate);
        assert.ok(gitlabCalls.includes('jobs:5'));
        assert.match(home.right.content, /build \/ build-api/);

        pressEnter();
        await new Promise(setImmediate);
        await new Promise(setImmediate);
        assert.ok(gitlabCalls.includes('trace:50'));
        assert.equal(home.rightContext(), 'trace');
        assert.match(home.right.content, /\{red-fg\}error TS2345/, 'ANSI стал тегом blessed');

        press('/', 'slash');
        type('boom');
        assert.deepEqual(home.search.matches, [1], 'поиск работает и по трассе');
        press(null, 'escape');
        press(null, 'escape');
        assert.equal(home.rightContext(), 'jobs');
    } finally {
        cleanup();
    }
});

test('запуск и отмена пайплайна только после подтверждения', async () => {
    const { app, home, press, pipelines, gitlabCalls, cleanup } = bootstrap();
    try {
        await pipelines.refresh();
        home.model.rebuild();
        home.render();

        press('p', 'p');
        assert.ok(app.stack.top() instanceof ConfirmView);
        assert.match(app.stack.top().text, /ветке "master"/);
        press(null, 'n');
        assert.equal(
            gitlabCalls.some((call) => call.startsWith('create:')),
            false,
            'отмена ничего не запустила'
        );

        press('p', 'p');
        press(null, 'y');
        await new Promise(setImmediate);
        assert.ok(gitlabCalls.includes('create:master'));

        home.model.selectKey('pipeline:5');
        press('s', 's');
        assert.ok(app.stack.top() instanceof ConfirmView);
        press(null, 'y');
        await new Promise(setImmediate);
        assert.ok(gitlabCalls.includes('cancel:5'));
    } finally {
        cleanup();
    }
});

test('foreground-режим снимает и восстанавливает screen', () => {
    const { app, screen, cleanup } = bootstrap();
    try {
        app.launch({
            command: 'build',
            workspace: 'apps/api',
            runMode: 'default',
            foreground: true,
        });
        assert.ok(screen.left && screen.entered);
    } finally {
        cleanup();
    }
});

// --- Docker Compose -----------------------------------------------------------

const {
    ComposeStore: Store,
    ComposeProject: Project,
    DockerCli: Cli,
} = require('../src/task-runner.js');

function composeStub() {
    const project = new Project({
        file: '/srv/app/docker-compose.yml',
        dir: '/srv/app',
        name: 'vkboss-light',
    });
    return new Store({
        project,
        cli: new Cli({ composeFile: project.file }),
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

async function composeHome(extra = {}) {
    const compose = composeStub();
    const harness = bootstrap({ compose, ...extra });
    await compose.refresh();
    harness.home.model.rebuild();
    harness.home.model.selectKey('compose:vkboss-light');
    harness.home.render();
    return { ...harness, compose };
}

test('секция compose: строка проекта слева, контейнеры справа', async () => {
    const { home, cleanup } = await composeHome();
    try {
        assert.match(home.side.content, /Compose/);
        assert.match(home.side.content, /vkboss-light\s+2\/3/);
        assert.equal(home.rightContext(), 'containers');
        assert.match(home.right.content, /весь проект \(3\)/);
        assert.match(home.right.content, /gptboss-llm/);
        assert.match(home.right.content, /Exited \(1\)/);
    } finally {
        cleanup();
    }
});

test('буквы фильтруют контейнеры и ничего не запускают', async () => {
    const { app, home, press, type, cleanup } = await composeHome();
    try {
        press(null, 'right');
        type('hist');

        assert.equal(home.containers.filter, 'hist');
        assert.deepEqual(
            home
                .visibleContainers()
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
    const { home, press, type, cleanup } = await composeHome();
    try {
        press(null, 'right');
        type('chat');
        press(null, 'down');
        const chosen = home.selectedContainer()?.service;
        assert.equal(chosen, 'gptboss-chat');

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

test('Enter на контейнере открывает меню, а не запускает', async () => {
    const { app, press, pressEnter, cleanup } = await composeHome();
    try {
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
    const { app, press, pressEnter, cleanup } = await composeHome();
    try {
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
    const { app, press, pressEnter, cleanup } = await composeHome();
    try {
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
    const { app, press, pressEnter, cleanup } = await composeHome();
    try {
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
    const { app, press, pressEnter, cleanup } = await composeHome();
    try {
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

test('откат: каталог, подтверждение с digest, цепочка и пометка', async () => {
    const { app, compose, press, pressEnter, cleanup } = await composeHome({
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

test('состояние контейнеров опрашивается по тику, пока секция видна', async () => {
    const { app, compose, cleanup } = await composeHome({ tickMs: 1000 });
    try {
        let refreshes = 0;
        compose.refresh = async () => {
            refreshes += 1;
        };

        for (let tick = 0; tick < 5; tick += 1) {
            app.onTick();
        }

        assert.equal(refreshes, 1, 'один опрос за 5 секунд, а не на каждый кадр');
    } finally {
        cleanup();
    }
});

test('r перечитывает состояние контейнеров немедленно', async () => {
    const { compose, press, cleanup } = await composeHome();
    try {
        let refreshes = 0;
        compose.refresh = async () => {
            refreshes += 1;
        };

        press('r', 'r');

        assert.equal(refreshes, 1);
    } finally {
        cleanup();
    }
});
