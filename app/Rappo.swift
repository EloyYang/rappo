// Rappo(라포) 메뉴막대 앱 — 녹취·카카오톡을 옵시디언 노트로.
// - 녹취 폴더를 감시해 새 파일이 들어오면 run.sh 실행
// - 카카오톡: DB 파일이 바뀌면(변경 감지) 그리고/또는 일정 주기로 run.sh --kakao-db 실행
// - 설정 창에서 폴더·반영 방식 등을 바꾸면 run.sh 에 APP_RAPPO_* 환경변수로 전달
// - 앱이 직접 python 을 띄우므로, '전체 디스크 접근 권한'은 이 앱 하나에만 주면 된다.
import Cocoa
import ServiceManagement
import UniformTypeIdentifiers
import EventKit

let kakaoDBDir = NSHomeDirectory() + "/Library/Containers/com.kakao.KakaoTalkMac/Data/Library/Application Support/com.kakao.KakaoTalkMac"

enum KakaoMode: Int { case change = 0, interval = 1, both = 2 }
// 녹취 폴더 감시: 자동 = 로컬 폴더면 변경 감지, 네트워크 드라이브면 주기 확인
enum RecordMode: Int { case auto = 0, change = 1, poll = 2, both = 3 }

func isNetworkVolume(_ path: String) -> Bool {
    let v = try? URL(fileURLWithPath: path).resourceValues(forKeys: [.volumeIsLocalKey])
    return v?.volumeIsLocal == false
}

// MARK: - 설정 (UserDefaults, 비어 있으면 config.sh 값)

final class Settings {
    let d = UserDefaults.standard
    var base: [String: String] = [:]      // config.sh 값
    var homeDir = NSHomeDirectory() + "/.venvs/rappo"

    init(codeDir: String) {
        if let text = try? String(contentsOfFile: codeDir + "/config.sh", encoding: .utf8) {
            for line in text.split(separator: "\n") {
                guard line.hasPrefix("export "), let eq = line.firstIndex(of: "=") else { continue }
                let key = String(line[line.index(line.startIndex, offsetBy: 7)..<eq])
                base[key] = line[line.index(after: eq)...].trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
            }
        }
        if let h = base["RAPPO_HOME"] { homeDir = h }
        // 예전 이름(CallNotes) 시절 설정을 한 번 옮겨 온다
        if d.object(forKey: "migratedFromCallNotes") == nil, let old = UserDefaults(suiteName: "com.eloy.callnotes") {
            for k in Settings.keys { if let v = old.object(forKey: k) { d.set(v, forKey: k) } }
            d.set(true, forKey: "migratedFromCallNotes")
        }
        d.register(defaults: ["kakaoMode": KakaoMode.change.rawValue, "intervalMin": 30,
                              "quietSec": 60, "minGapMin": 5, "summary": true, "pollMin": 5, "recordMode": 0, "kakaoOn": true])
    }

    private func path(_ key: String, _ envKey: String) -> String {
        let v = d.string(forKey: key) ?? ""
        return v.isEmpty ? (base[envKey] ?? "") : v
    }
    var recordDir: String { get { path("recordDir", "RAPPO_RECORD") } set { d.set(newValue, forKey: "recordDir") } }
    var vaultDir: String { get { path("vaultDir", "RAPPO_VAULT") } set { d.set(newValue, forKey: "vaultDir") } }
    var kakaoDir: String { get { path("kakaoDir", "RAPPO_KAKAO") } set { d.set(newValue, forKey: "kakaoDir") } }
    var kakaoMe: String { get { d.string(forKey: "kakaoMe") ?? "" } set { d.set(newValue, forKey: "kakaoMe") } }
    var kakaoMode: KakaoMode {
        get { KakaoMode(rawValue: d.integer(forKey: "kakaoMode")) ?? .change }
        set { d.set(newValue.rawValue, forKey: "kakaoMode") }
    }
    var intervalMin: Int { get { max(5, d.integer(forKey: "intervalMin")) } set { d.set(newValue, forKey: "intervalMin") } }
    var quietSec: Int { get { max(10, d.integer(forKey: "quietSec")) } set { d.set(newValue, forKey: "quietSec") } }
    var minGapMin: Int { get { max(0, d.integer(forKey: "minGapMin")) } set { d.set(newValue, forKey: "minGapMin") } }
    var summary: Bool { get { d.bool(forKey: "summary") } set { d.set(newValue, forKey: "summary") } }
    var kakaoOn: Bool { get { d.bool(forKey: "kakaoOn") } set { d.set(newValue, forKey: "kakaoOn") } }
    // 요약 AI: 0 자동(로컬 모델이 켜져 있으면 로컬) · 1 로컬(Ollama) · 2 Claude Code
    var aiEngine: Int { get { d.integer(forKey: "aiEngine") } set { d.set(newValue, forKey: "aiEngine") } }
    // 비우면 자동: MLX 가 있으면 mlx-community/Qwen3.5-4B-MLX-4bit, 아니면 Ollama qwen3.5:4b
    var aiModel: String { get { d.string(forKey: "aiModel") ?? "" } set { d.set(newValue, forKey: "aiModel") } }
    // 캘린더: 챙길 날·대화 일정을 넣을 캘린더 (EventKit — 맥 캘린더에 연결된 구글 캘린더 포함)
    // 정리 시간: 0 실시간 · 1 받아 적기는 바로, AI 정리는 정해진 시간에 · 2 모두 정해진 시간에 몰아서
    var runMode: Int { get { d.integer(forKey: "runMode") } set { d.set(newValue, forKey: "runMode") } }
    var winStart: Int { get { d.object(forKey: "winStart") == nil ? 2 : d.integer(forKey: "winStart") } set { d.set(newValue, forKey: "winStart") } }
    var winEnd: Int { get { d.object(forKey: "winEnd") == nil ? 6 : d.integer(forKey: "winEnd") } set { d.set(newValue, forKey: "winEnd") } }
    func inWindow(_ date: Date = Date()) -> Bool {
        let h = Calendar.current.component(.hour, from: date)
        return winStart <= winEnd ? (h >= winStart && h < winEnd) : (h >= winStart || h < winEnd)
    }
    var calOn: Bool { get { d.bool(forKey: "calOn") } set { d.set(newValue, forKey: "calOn") } }
    var calId: String { get { d.string(forKey: "calId") ?? "" } set { d.set(newValue, forKey: "calId") } }
    // 이 시각(통화 시각) 이전 녹취는 건너뜀. "yyyy-MM-dd HH:mm", 비우면 전부
    var since: String { get { d.string(forKey: "since") ?? "" } set { d.set(newValue, forKey: "since") } }
    var recordMode: RecordMode {
        get { RecordMode(rawValue: d.integer(forKey: "recordMode")) ?? .auto }
        set { d.set(newValue.rawValue, forKey: "recordMode") }
    }
    var pollMin: Int { get { max(1, d.integer(forKey: "pollMin")) } set { d.set(newValue, forKey: "pollMin") } }

    static func nowStamp() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm"; f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: Date())
    }

    static let keys = ["recordDir", "vaultDir", "kakaoDir", "kakaoMe", "kakaoMode", "intervalMin", "quietSec", "minGapMin", "summary", "since", "pollMin", "recordMode", "kakaoOn", "aiEngine", "aiModel", "calOn", "calId", "runMode", "winStart", "winEnd"]
    // 볼트 안에서 노트를 모아 두는 폴더 (install.sh 가 config.sh 에 적음)
    var baseDir: String { let b = base["RAPPO_BASE"] ?? ""; return b.isEmpty ? "2. Areas/통화기록" : b }

    func reset() {
        for k in Settings.keys {
            d.removeObject(forKey: k)
        }
    }

    // run.sh 에 넘길 환경변수 (사용자가 직접 지정한 값만)
    var env: [String: String] {
        var e: [String: String] = [:]
        for (k, envKey) in [("recordDir", "RECORD"), ("vaultDir", "VAULT"), ("kakaoDir", "KAKAO"), ("kakaoMe", "KAKAO_ME"), ("since", "SINCE")] {
            if let v = d.string(forKey: k), !v.isEmpty { e["APP_RAPPO_" + envKey] = v }
        }
        e["APP_RAPPO_AI"] = ["auto", "local", "claude"][max(0, min(2, aiEngine))]
        if !aiModel.isEmpty && aiModel != "qwen3.5:4b" { e["APP_RAPPO_AI_MODEL"] = aiModel }
        return e
    }
}

// MARK: - FSEvents 감시

final class Watcher {
    private var stream: FSEventStreamRef?
    private let handler: ([String]) -> Void

    init?(path: String, handler: @escaping ([String]) -> Void) {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        self.handler = handler
        var ctx = FSEventStreamContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil)
        ctx.info = Unmanaged.passUnretained(self).toOpaque()
        let cb: FSEventStreamCallback = { _, info, n, paths, _, _ in
            let me = Unmanaged<Watcher>.fromOpaque(info!).takeUnretainedValue()
            let arr = unsafeBitCast(paths, to: NSArray.self) as? [String] ?? []
            me.handler(Array(arr.prefix(n)))
        }
        let flags = kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes
        stream = FSEventStreamCreate(nil, cb, &ctx, [path] as CFArray,
                                     FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 2.0,
                                     FSEventStreamCreateFlags(flags))
        guard let s = stream else { return nil }
        FSEventStreamSetDispatchQueue(s, DispatchQueue.main)
        FSEventStreamStart(s)
    }

    deinit {
        if let s = stream { FSEventStreamStop(s); FSEventStreamInvalidate(s); FSEventStreamRelease(s) }
    }
}

// MARK: - 앱

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    let statusLine = NSMenuItem(title: "대기 중", action: nil, keyEquivalent: "")
    let lastLine = NSMenuItem(title: "마지막 실행: -", action: nil, keyEquivalent: "")
    let modeLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let recordLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let loginItem = NSMenuItem(title: "로그인 시 자동 실행", action: #selector(toggleLogin), keyEquivalent: "")

    var codeDir = ""
    var s: Settings!
    var settingsWC: SettingsWindow?

    var running: Process?
    var pendingArgs: [String]? = nil
    var lastKakaoRun = Date.distantPast

    var timer: Timer?
    var recordDebounce: Timer?
    var kakaoDebounce: Timer?
    var watchers: [Watcher] = []
    var pollTimer: Timer?
    var knownRecords: Set<String>? = nil   // 주기 확인용: 마지막으로 본 녹취 파일 목록
    var dayTimer: Timer?
    var windowTimer: Timer?
    var deferredWork = false      // 정해진 시간까지 미뤄 둔 일이 있음
    var fdaWarned = false
    var catchUpQueued = false
    let events = EKEventStore()
    var calWatcher: Watcher?
    var calDebounce: Timer?
    var dayItems: [NSMenuItem] = []

    func applicationDidFinishLaunching(_ n: Notification) {
        codeDir = Bundle.main.infoDictionary?["CNCodeDir"] as? String ?? ""
        s = Settings(codeDir: codeDir)
        buildMenu()
        setIcon(busy: false)
        applySettings()
        // 시작 직후 한 번 (동기화가 붙을 시간을 조금 준다)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.request(["--kakao-db"]) }
        // 챙길 날 알림: 시작 30초 뒤, 그다음 1시간마다 (7·3·1일 전과 당일, 한 번씩)
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.checkDays() }
        dayTimer = Timer.scheduledTimer(withTimeInterval: 1800, repeats: true) { [weak self] _ in self?.checkDays(); self?.syncCalendar(); self?.exportEvents() }
        windowTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in self?.checkWindow() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 35) { [weak self] in self?.syncCalendar(); self?.exportEvents() }
        NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: events, queue: .main) { [weak self] _ in
            self?.calDebounce?.invalidate()
            self?.calDebounce = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in self?.exportEvents() }
        }
    }

    // 이미 실행 중일 때 앱을 다시 열면(Finder 더블클릭 등) 설정 창
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openSettings()
        return false
    }

    // 설정이 바뀔 때마다 감시·타이머를 다시 건다
    func applySettings() {
        watchers.removeAll()
        // 옵시디언에서 녹음한 회의 (볼트/<저장 폴더>/회의/녹음)
        let meetDir = s.vaultDir + "/" + s.baseDir + "/회의/녹음"
        if FileManager.default.fileExists(atPath: s.vaultDir + "/.obsidian") {
            try? FileManager.default.createDirectory(atPath: meetDir, withIntermediateDirectories: true)
            if let w = Watcher(path: meetDir, handler: { [weak self] _ in self?.recordChanged() }) { watchers.append(w) }
        }
        // 옵시디언 플러그인이 calendar.json 을 고치면 바로 캘린더에 반영
        calWatcher = Watcher(path: pluginDir) { [weak self] paths in
            guard paths.contains(where: { $0.hasSuffix("calendar.json") }) else { return }
            self?.calDebounce?.invalidate()
            self?.calDebounce = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in self?.syncCalendar() }
        }
        timer?.invalidate(); timer = nil
        recordDebounce?.invalidate(); kakaoDebounce?.invalidate()
        pollTimer?.invalidate()
        knownRecords = nil
        // 네트워크 드라이브(SMB 등)는 다른 기기가 넣은 파일을 FSEvents 로 알려주지 않으므로 직접 확인
        let network = isNetworkVolume(s.recordDir)
        var useWatch = true, usePoll = true
        switch s.recordMode {
        case .auto: useWatch = !network; usePoll = network
        case .change: usePoll = false
        case .poll: useWatch = false
        case .both: break
        }
        if usePoll {
            pollRecords()
            pollTimer = Timer.scheduledTimer(withTimeInterval: TimeInterval(s.pollMin * 60), repeats: true) { [weak self] _ in
                self?.pollRecords()
            }
        }
        var watching = false
        if useWatch, let w = Watcher(path: s.recordDir, handler: { [weak self] _ in self?.recordChanged() }) {
            watchers.append(w)
            watching = true
        }
        let where_ = network ? "네트워크 드라이브" : "로컬 폴더"
        switch (watching, usePoll) {
        case (true, true): recordLine.title = "녹취: 변경 감지 + \(s.pollMin)분마다 확인 (\(where_))"
        case (true, false): recordLine.title = "녹취: 변경 감지 (\(where_))"
        case (false, true): recordLine.title = "녹취: \(s.pollMin)분마다 새 파일 확인 (\(where_))"
        case (false, false): recordLine.title = "녹취: 감시 안 함 — 폴더를 확인하세요"
        }
        let mode = s.kakaoMode
        if !s.kakaoOn { modeLine.title = "카톡: 가져오지 않음"; return }
        if mode != .interval {
            if let w = Watcher(path: kakaoDBDir, handler: { [weak self] paths in self?.kakaoDBChanged(paths) }) {
                watchers.append(w)
            }
            if let w = Watcher(path: s.kakaoDir, handler: { [weak self] _ in self?.kakaoChanged() }) {
                watchers.append(w)
            }
        }
        if mode != .change {
            timer = Timer.scheduledTimer(withTimeInterval: TimeInterval(s.intervalMin * 60), repeats: true) { [weak self] _ in
                self?.request(["--kakao-db"])
            }
        }
        switch mode {
        case .change: modeLine.title = "카톡: 변경 감지"
        case .interval: modeLine.title = "카톡: \(s.intervalMin)분마다"
        case .both: modeLine.title = "카톡: 변경 감지 + \(s.intervalMin)분마다"
        }
    }

    func buildMenu() {
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        add("지금 정리하기", #selector(runNow), "r")
        add("옵시디언에서 라포 홈 열기", #selector(openDashboard), "d")
        menu.addItem(.separator())
        add("설정…", #selector(openSettings), ",")
        add("Rappo 종료", #selector(quit), "q")
        item.menu = menu
        updateStatus()
    }

    // 메뉴 맨 위 한 줄: 지금 상태 · 마지막 정리 시각
    var lastRun = ""
    var lastError = false
    func updateStatus(_ now: String? = nil) {
        let state = now ?? (running != nil ? "정리 중…" : "대기 중")
        var t = "● " + state
        if s.kakaoOn && !hasFullDiskAccess { t = "⚠️ 전체 디스크 접근 권한 필요 (카톡을 못 읽어요)" }
        if s.runMode != 0 && running == nil {
            t += s.inWindow() ? " (몰아서 정리하는 시간)" : (deferredWork ? " · \(s.winStart)시에 몰아서 정리 예정" : "")
        }
        if !lastRun.isEmpty { t += " · 마지막 정리 " + lastRun + (lastError ? " (문제 있음)" : "") }
        statusLine.title = t
    }

    func add(_ title: String, _ sel: Selector, _ key: String) {
        let m = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        m.target = self
        menu.addItem(m)
    }

    func menuWillOpen(_ menu: NSMenu) {
        updateStatus()
        // 상태 줄 아래에 14일 안의 챙길 날 (최대 3개)
        for m in dayItems { menu.removeItem(m) }
        dayItems = upcomingDays().filter { $0.dday <= 14 }.prefix(3).map { e in
            let m = NSMenuItem(title: "\(e.icon) \(e.dday == 0 ? "오늘" : "D-\(e.dday)") · \(e.title)", action: #selector(openDashboard), keyEquivalent: "")
            m.target = self
            m.toolTip = e.sub
            return m
        }
        for (i, m) in dayItems.enumerated() { menu.insertItem(m, at: 1 + i) }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    func setIcon(busy: Bool) {
        item.button?.image = AppDelegate.barIcon(busy: busy)
        item.button?.toolTip = "Rappo"
        updateStatus()
    }

    // 로고와 같은 모양: 대각선으로 다가선 두 원의 교집합
    static func barIcon(busy: Bool) -> NSImage {
        let img = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
            let l = NSRect(x: 2.2, y: 6.0, width: 10.6, height: 10.6)   // 왼쪽 위
            let r = NSRect(x: 7.4, y: 1.4, width: 10.6, height: 10.6)   // 오른쪽 아래
            NSColor.black.set()
            let lp = NSBezierPath(ovalIn: l), rp = NSBezierPath(ovalIn: r)
            lp.lineWidth = 1.1; rp.lineWidth = 1.1
            if busy { lp.stroke() } else { lp.fill() }   // 기본: 왼쪽 원 채움, 정리 중: 겹친 곳만
            rp.stroke()
            NSGraphicsContext.saveGraphicsState()
            lp.addClip()
            NSBezierPath(ovalIn: r).fill()   // 교집합
            NSGraphicsContext.restoreGraphicsState()
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = "Rappo"
        return img
    }

    // MARK: 변경 감지

    func recordChanged() {
        recordDebounce?.invalidate()
        recordDebounce = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in
            self?.request([])
        }
    }

    func pollRecords() {
        let dir = s.recordDir
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
            let now = Set(names.filter { !$0.hasPrefix(".") })
            DispatchQueue.main.async {
                guard let self = self, dir == self.s.recordDir else { return }
                if let old = self.knownRecords, !now.subtracting(old).isEmpty { self.recordChanged() }
                self.knownRecords = now
            }
        }
    }

    // 카톡 DB 파일(78자리 hex 이름, -wal/-shm 포함)만 반응
    func kakaoDBChanged(_ paths: [String]) {
        let hit = paths.contains { p in
            let name = (p as NSString).lastPathComponent
            let stem = name.split(separator: "-").first.map(String.init) ?? name
            return stem.count == 78 && stem.allSatisfy { $0.isHexDigit }
        }
        if hit { kakaoChanged() }
    }

    // 대화 중엔 계속 바뀌므로, 조용해진 뒤 + 최소 간격을 지켜서 실행
    func kakaoChanged() {
        kakaoDebounce?.invalidate()
        let earliest = lastKakaoRun.addingTimeInterval(TimeInterval(s.minGapMin * 60))
        let wait = max(TimeInterval(s.quietSec), earliest.timeIntervalSinceNow)
        kakaoDebounce = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            self?.request(["--kakao-db"])
        }
        if running == nil { updateStatus("카톡 새 대화 — 곧 정리") }
    }

    // MARK: 실행

    func request(_ args: [String], manual: Bool = false) {
        var args = args
        // 정리 시간: 정해진 시간 밖이면 미루거나(모두) AI 만 미룬다. 직접 누른 '지금 정리하기'는 바로.
        if !manual && !s.inWindow() && !args.contains("--catch-up") && !args.contains("--setup-obsidian") {
            if s.runMode == 2 { deferredWork = true; updateStatus(); return }
            if s.runMode == 1 && !args.contains("--resummarize") { args.append("--no-summary"); deferredWork = true }
        }
        if !s.summary && !args.contains("--resummarize") && !args.contains("--no-summary") { args.append("--no-summary") }
        if !s.kakaoOn { args.removeAll { $0 == "--kakao-db" } }
        if running != nil {
            if pendingArgs == nil || args.contains("--kakao-db") { pendingArgs = args }
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [codeDir + "/run.sh"] + args
        p.environment = ProcessInfo.processInfo.environment.merging(s.env) { $1 }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.finished(proc) }
        }
        do {
            try p.run()
            running = p
            if args.contains("--kakao-db") { lastKakaoRun = Date() }
            setIcon(busy: true)
        } catch {
            lastLine.title = "실행 실패: \(error.localizedDescription)"
        }
    }

    func finished(_ p: Process) {
        running = nil
        setIcon(busy: false)
        defer {
            if running == nil, pendingArgs == nil, catchUpQueued { catchUpQueued = false; request(["--catch-up"], manual: true) }
        }
        let f = DateFormatter()
        f.dateFormat = "M/d HH:mm"
        let ok = p.terminationStatus == 0 ? "" : " (오류 \(p.terminationStatus) — 로그 확인)"
        lastLine.title = "마지막 실행: \(f.string(from: Date()))\(ok)"
        lastRun = f.string(from: Date())
        lastError = p.terminationStatus != 0
        // 권한이 풀려 카톡을 못 읽으면 한 번 알림 (앱을 다시 빌드하면 macOS 가 권한을 풀 때가 있음)
        if s.kakaoOn && !hasFullDiskAccess && !fdaWarned {
            fdaWarned = true
            notify("카카오톡 대화를 읽지 못했어요", "시스템 설정 › 전체 디스크 접근 권한에서 Rappo 를 껐다 켜 주세요", header: "Rappo")
        }
        updateStatus()
        settingsWC?.refreshStatus()
        let a = p.arguments ?? []
        if a.contains("--setup-obsidian") {
            if p.terminationStatus == 0 {
                alert("옵시디언 설치 완료", "볼트에 '\(s.baseDir)/라포 홈'과 Rappo 플러그인을 넣었습니다.\n옵시디언을 다시 열고, 물어보면 '플러그인 사용(신뢰)'을 눌러 주세요.")
            } else { alert("옵시디언 설치 실패", "로그 보기에서 내용을 확인해 주세요.") }
        } else if a.contains("--enroll") {
            alert(p.terminationStatus == 0 ? "내 목소리를 등록했습니다" : "목소리 등록 실패", p.terminationStatus == 0 ? "다음 통화부터 '나'를 구분합니다." : "로그 보기에서 내용을 확인해 주세요.")
        }
        if let next = pendingArgs {
            pendingArgs = nil
            request(next)
        }
    }

    @objc func runNow() {
        // 지금 정리하기: 미뤄 둔 AI 정리까지 한꺼번에
        request(["--kakao-db"], manual: true)
        if s.runMode != 0 || deferredWork { catchUpQueued = true; deferredWork = false }
    }
    // 정해진 시간이 되면 몰아서: 새 녹취·카톡 → 미뤄 둔 AI 정리 (하루 한 번 + 그 뒤 생긴 일)
    func checkWindow() {
        guard s.runMode != 0, s.inWindow() else { return }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        let today = f.string(from: Date())
        let ud = UserDefaults.standard
        guard deferredWork || ud.string(forKey: "lastCatchUp") != today else { return }
        ud.set(today, forKey: "lastCatchUp")
        deferredWork = false
        request(s.kakaoOn ? ["--kakao-db"] : [], manual: true)
        catchUpQueued = true
        updateStatus()
    }
    @objc func runRecordings() { request([]) }
    @objc func runResummarize() { request(["--resummarize"], manual: true) }

    // MARK: 열기

    @objc func openSettings() {
        if settingsWC == nil {
            settingsWC = SettingsWindow(settings: s, app: self)
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWC?.load()
        settingsWC?.showWindow(nil)
        settingsWC?.window?.makeKeyAndOrderFront(nil)
    }
    @objc func openLog() {
        let log = s.homeDir + "/logs/rappo.log"
        if FileManager.default.fileExists(atPath: log) {
            NSWorkspace.shared.open([URL(fileURLWithPath: log)],
                                    withApplicationAt: URL(fileURLWithPath: "/System/Applications/Utilities/Console.app"),
                                    configuration: NSWorkspace.OpenConfiguration())
        } else {
            alert("아직 로그가 없습니다.", log)
        }
    }
    @objc func openRecord() { openDir(s.recordDir) }
    @objc func openNotes() { openDir(s.vaultDir + "/" + s.baseDir) }

    var dashboardPath: String {
        let home = s.vaultDir + "/" + s.baseDir + "/라포 홈.md"
        let old = s.vaultDir + "/" + s.baseDir + "/통화기록 대시보드.md"
        return FileManager.default.fileExists(atPath: home) || !FileManager.default.fileExists(atPath: old) ? home : old
    }
    // MARK: 챙길 날 (옵시디언 Rappo 플러그인이 쓰는 upcoming.json)
    struct DayEvent { let date: String; let title: String; let sub: String; let dday: Int
        var icon: String { title.contains("생일") ? "🎂" : title.contains("기념일") || title.contains("주년") ? "💐" : "🗓" } }

    func upcomingDays() -> [DayEvent] {
        let p = s.vaultDir + "/.obsidian/plugins/rappo/upcoming.json"
        guard let data = FileManager.default.contents(atPath: p),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let evs = obj["events"] as? [[String: Any]] else { return [] }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
        let cal = Calendar.current, today = cal.startOfDay(for: Date())
        return evs.compactMap { e -> DayEvent? in
            guard let ds = e["date"] as? String, let t = e["title"] as? String, let d = f.date(from: ds) else { return nil }
            let n = cal.dateComponents([.day], from: today, to: cal.startOfDay(for: d)).day ?? -1
            return n >= 0 ? DayEvent(date: ds, title: t, sub: e["sub"] as? String ?? "", dday: n) : nil
        }.sorted { $0.dday < $1.dday }
    }

    func checkDays() {
        let ud = UserDefaults.standard
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
        let todayS = f.string(from: Date())
        // 지난 날짜의 기록은 지운다
        var sent = Set((ud.stringArray(forKey: "dayNotified") ?? []).filter { String($0.prefix(10)) >= todayS })
        for e in upcomingDays() where [7, 3, 1, 0].contains(e.dday) {
            let key = "\(e.date)|\(e.title)|\(e.dday)"
            if sent.contains(key) { continue }
            sent.insert(key)
            let head = e.dday == 0 ? "오늘은 \(e.title)" : "\(e.dday)일 뒤 \(e.title)"
            notify(head, e.sub.isEmpty ? e.date : "\(e.date) · \(e.sub)")
        }
        ud.set(Array(sent), forKey: "dayNotified")
    }

    // MARK: 캘린더 (calendar.json → EventKit)
    var pluginDir: String { s.vaultDir + "/.obsidian/plugins/rappo" }
    var calAccess: Bool {
        let st = EKEventStore.authorizationStatus(for: .event)
        if #available(macOS 14, *) { return st == .fullAccess }
        return st == .authorized
    }
    func requestCalendar(_ done: @escaping (Bool) -> Void) {
        let back: (Bool, Error?) -> Void = { ok, _ in DispatchQueue.main.async { done(ok) } }
        if #available(macOS 14, *) { events.requestFullAccessToEvents(completion: back) }
        else { events.requestAccess(to: .event, completion: back) }
    }
    func writableCalendars() -> [EKCalendar] {
        guard calAccess else { return [] }
        return events.calendars(for: .event).filter { $0.allowsContentModifications }
            .sorted { ($0.source.title, $0.title) < ($1.source.title, $1.title) }
    }
    func calLabel(_ c: EKCalendar) -> String { "\(c.source.title) · \(c.title)" }

    func syncCalendar() {
        guard s.calOn, calAccess else { return }
        events.reset()
        guard let cal = events.calendar(withIdentifier: s.calId) ?? events.defaultCalendarForNewEvents,
              let data = FileManager.default.contents(atPath: pluginDir + "/calendar.json"),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = obj["events"] as? [[String: Any]] else { return }
        let ud = UserDefaults.standard
        var added = ud.dictionary(forKey: "calAdded") as? [String: String] ?? [:]
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
        var n = 0
        for e in list {
            guard let id = e["id"] as? String, added[id] == nil, let title = e["title"] as? String, let ds = e["date"] as? String else { continue }
            let time = e["time"] as? String ?? ""
            f.dateFormat = time.isEmpty ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm"
            guard let start = f.date(from: time.isEmpty ? ds : "\(ds) \(time)") else { continue }
            let ev = EKEvent(eventStore: events)
            ev.calendar = cal
            ev.title = title
            ev.notes = (e["notes"] as? String ?? "") + "\n\n— Rappo"
            if time.isEmpty {
                ev.isAllDay = true; ev.startDate = start; ev.endDate = start
                ev.addAlarm(EKAlarm(relativeOffset: -15 * 3600))   // 전날 오전 9시
            } else {
                ev.startDate = start; ev.endDate = start.addingTimeInterval(3600)
                ev.addAlarm(EKAlarm(relativeOffset: -3600))         // 1시간 전
            }
            do { try events.save(ev, span: .thisEvent, commit: false); added[id] = ev.eventIdentifier ?? "?"; n += 1 }
            catch { NSLog("Rappo 캘린더 저장 실패: \(error)") }
        }
        // 지우기: 플러그인에서 사용자가 '캘린더에서도 지우기'를 확인한 것만
        var removed: [String] = []
        for id in (obj["remove"] as? [String]) ?? [] {
            guard let eid = added[id] else { continue }
            if let ev = events.event(withIdentifier: eid) {
                do { try events.remove(ev, span: .thisEvent, commit: false); n += 1 } catch { NSLog("Rappo 캘린더 지우기 실패: \(error)") }
            }
            added.removeValue(forKey: id); removed.append(id)
        }
        if n > 0 { try? events.commit() }
        ud.set(added, forKey: "calAdded")
        // 플러그인이 '캘린더에 들어감'을 보여 줄 수 있게
        let done: [String: Any] = ["calendar": calLabel(cal), "ids": Array(added.keys), "removed": removed]
        if let out = try? JSONSerialization.data(withJSONObject: done, options: [.prettyPrinted]) {
            let p = pluginDir + "/calendar-done.json"
            if FileManager.default.contents(atPath: p) != out { try? out.write(to: URL(fileURLWithPath: p)) }
        }
        if n - removed.count > 0 { notify("캘린더에 \(n - removed.count)개 넣었어요", calLabel(cal)) }
        exportEvents()
    }

    // 라포 홈의 캘린더 칸: 이번 달 달력과 앞으로 2주 일정을 플러그인 폴더에 (맥 캘린더에 연결된 구글 캘린더 포함)
    func exportEvents() {
        guard calAccess, !s.vaultDir.isEmpty, FileManager.default.fileExists(atPath: pluginDir) else { return }
        // 이번 달 달력(6주) + 앞으로 2주: 이번 달 1일이 든 주의 일요일부터 6주, 그리고 오늘부터 14일 중 늦은 쪽까지
        var cal = Calendar(identifier: .gregorian); cal.firstWeekday = 1
        let today0 = cal.startOfDay(for: Date())
        let first = cal.date(from: cal.dateComponents([.year, .month], from: today0)) ?? today0
        let start = cal.date(byAdding: .day, value: -(cal.component(.weekday, from: first) - 1), to: first) ?? first
        guard let gridEnd = cal.date(byAdding: .day, value: 42, to: start), let soonEnd = cal.date(byAdding: .day, value: 14, to: today0) else { return }
        let end = max(gridEnd, soonEnd)
        let pred = events.predicateForEvents(withStart: start, end: end, calendars: nil)
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; f.timeZone = TimeZone.current
        func hex(_ c: CGColor?) -> String {
            guard let c = c, let rgb = NSColor(cgColor: c)?.usingColorSpace(.sRGB) else { return "#7c5cff" }
            return String(format: "#%02x%02x%02x", Int(rgb.redComponent * 255), Int(rgb.greenComponent * 255), Int(rgb.blueComponent * 255))
        }
        let list: [[String: Any]] = events.events(matching: pred).sorted { $0.startDate < $1.startDate }.prefix(300).map { e in
            ["title": e.title ?? "", "start": f.string(from: e.startDate), "end": f.string(from: e.endDate), "allDay": e.isAllDay,
             "color": hex(e.calendar.cgColor), "calendar": e.calendar.title, "location": e.location ?? ""]
        }
        let obj: [String: Any] = ["made": f.string(from: Date()), "events": list]
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) {
            try? data.write(to: URL(fileURLWithPath: pluginDir + "/calendar-events.json"))
        }
    }

    // 로컬 모델(Ollama) 상태
    func ollamaState(_ done: @escaping (Bool, [String]) -> Void) {
        guard let u = URL(string: "http://127.0.0.1:11434/api/tags") else { return done(false, []) }
        var req = URLRequest(url: u); req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var names: [String] = []
            if let data = data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let ms = o["models"] as? [[String: Any]] { names = ms.compactMap { $0["name"] as? String } }
            DispatchQueue.main.async { done(data != nil, names) }
        }.resume()
    }

    func notify(_ title: String, _ body: String, header: String = "Rappo · 챙길 날") {
        func esc(_ x: String) -> String { x.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "display notification \"\(esc(body))\" with title \"\(esc(header))\" subtitle \"\(esc(title))\" sound name \"Glass\""]
        try? p.run()
    }

    @objc func openDashboard() {
        guard FileManager.default.fileExists(atPath: dashboardPath) else {
            alert("대시보드가 아직 없어요", "설정… → 일반 → '옵시디언에 설치'를 눌러 주세요.")
            return
        }
        var c = URLComponents(string: "obsidian://open")!
        c.queryItems = [URLQueryItem(name: "path", value: dashboardPath)]
        if let u = c.url { NSWorkspace.shared.open(u) }
    }
    // 카카오톡 데이터 폴더를 읽을 수 있으면 전체 디스크 접근 권한이 있는 것
    var hasFullDiskAccess: Bool {
        (try? FileManager.default.contentsOfDirectory(atPath: NSHomeDirectory() + "/Library/Containers/com.kakao.KakaoTalkMac/Data/Library")) != nil
            || (try? FileManager.default.contentsOfDirectory(atPath: NSHomeDirectory() + "/Library/Safari")) != nil
    }
    var loginEnabled: Bool { SMAppService.mainApp.status == .enabled }

    @objc func setupObsidian() {
        guard !s.vaultDir.isEmpty, FileManager.default.fileExists(atPath: s.vaultDir + "/.obsidian") else {
            alert("옵시디언 볼트를 찾을 수 없습니다", "설정… 에서 옵시디언 볼트 폴더를 먼저 지정해 주세요.\n지금 값: \(s.vaultDir)")
            return
        }
        request(["--setup-obsidian"])
    }

    @objc func enrollVoice() {
        let p = NSOpenPanel()
        p.message = "내 목소리만 들어 있는 녹음 파일(10초 이상)을 고르세요. 통화 전사문에서 '나'를 구분하는 데 씁니다."
        p.allowedContentTypes = [.audio]
        NSApp.activate(ignoringOtherApps: true)
        if p.runModal() == .OK, let url = p.url { request(["--enroll", url.path]) }
    }
    func openDir(_ path: String) {
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        } else {
            alert("폴더를 찾을 수 없습니다.", path)
        }
    }
    @objc func openPrivacy() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
    }

    @objc func toggleLogin() {
        let sv = SMAppService.mainApp
        do {
            if sv.status == .enabled { try sv.unregister() } else { try sv.register() }
        } catch {
            alert("로그인 항목 설정 실패", error.localizedDescription)
        }
    }

    @objc func quit() {
        running?.terminate()
        NSApp.terminate(nil)
    }

    func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }
}

// MARK: - 설정 창

final class SettingsWindow: NSWindowController {
    let s: Settings
    weak var app: AppDelegate?

    // 일반
    let recordField = SettingsWindow.pathLabel()
    let skipOldCheck = NSButton(checkboxWithTitle: "이 시각 이전 녹취는 건너뛰기", target: nil, action: nil)
    let sincePicker = NSDatePicker()
    let summaryCheck = NSButton(checkboxWithTitle: "통화 요약 만들기 (요약 · 할 일 · 정한 일정)", target: nil, action: nil)
    // AI·캘린더
    let aiPopup = NSPopUpButton()
    let modelField = NSTextField()
    let aiState = SettingsWindow.note("")
    let calCheck = NSButton(checkboxWithTitle: "챙길 날과 대화에서 정한 일정을 캘린더에 넣기", target: nil, action: nil)
    let calPopup = NSPopUpButton()
    let calState = SettingsWindow.note("")
    let vaultField = SettingsWindow.pathLabel()
    let obsidianState = SettingsWindow.note("")
    let loginCheck = NSButton(checkboxWithTitle: "로그인하면 Rappo 자동 실행", target: nil, action: nil)
    let fdaState = NSTextField(labelWithString: "")
    let runPopup = NSPopUpButton()
    let startPopup = NSPopUpButton()
    let endPopup = NSPopUpButton()
    let runNote = SettingsWindow.note("")
    // 카카오톡
    let kakaoCheck = NSButton(checkboxWithTitle: "카카오톡 대화 가져오기", target: nil, action: nil)
    let modePopup = NSPopUpButton()
    let intervalField = SettingsWindow.numField()
    let meField = NSTextField()
    // 고급
    let recordPopup = NSPopUpButton()
    let pollField = SettingsWindow.numField()
    let kakaoField = SettingsWindow.pathLabel()
    let watchState = SettingsWindow.note("")

    init(settings: Settings, app: AppDelegate) {
        s = settings
        self.app = app
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 400),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Rappo 설정"
        w.isReleasedWhenClosed = false
        super.init(window: w)
        build()
        w.center()
    }
    required init?(coder: NSCoder) { fatalError() }

    // MARK: 부품
    static func pathLabel() -> NSTextField {
        let f = NSTextField(labelWithString: "")
        f.lineBreakMode = .byTruncatingMiddle
        f.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        f.widthAnchor.constraint(equalToConstant: 300).isActive = true
        return f
    }
    static func numField() -> NSTextField {
        let f = NSTextField()
        f.alignment = .right
        f.widthAnchor.constraint(equalToConstant: 48).isActive = true
        let nf = NumberFormatter(); nf.allowsFloats = false; nf.minimum = 1
        f.formatter = nf
        return f
    }
    static func note(_ t: String) -> NSTextField {
        let f = NSTextField(wrappingLabelWithString: t)
        f.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        f.textColor = .secondaryLabelColor
        f.preferredMaxLayoutWidth = 470
        return f
    }
    func header(_ t: String) -> NSTextField {
        let f = NSTextField(labelWithString: t)
        f.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
        return f
    }
    func button(_ t: String, _ sel: Selector) -> NSButton {
        let b = NSButton(title: t, target: self, action: sel)
        b.bezelStyle = .rounded
        return b
    }
    func row(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
        let r = NSStackView(views: views)
        r.spacing = spacing
        r.alignment = .firstBaseline
        return r
    }
    func page(_ views: [NSView]) -> NSView {
        let st = NSStackView(views: views)
        st.orientation = .vertical
        st.alignment = .leading
        st.spacing = 10
        st.edgeInsets = NSEdgeInsets(top: 18, left: 22, bottom: 18, right: 22)
        st.translatesAutoresizingMaskIntoConstraints = false
        let v = NSView()
        v.addSubview(st)
        NSLayoutConstraint.activate([
            st.topAnchor.constraint(equalTo: v.topAnchor), st.leadingAnchor.constraint(equalTo: v.leadingAnchor),
            st.trailingAnchor.constraint(equalTo: v.trailingAnchor),
            st.bottomAnchor.constraint(lessThanOrEqualTo: v.bottomAnchor),
        ])
        return v
    }
    func gap(_ h: CGFloat = 6) -> NSView { let v = NSView(); v.heightAnchor.constraint(equalToConstant: h).isActive = true; return v }

    // MARK: 화면
    func build() {
        for c in [skipOldCheck, summaryCheck, loginCheck, kakaoCheck, calCheck] { c.target = self; c.action = #selector(changed) }
        runPopup.addItems(withTitles: ["실시간 (들어오면 바로)", "받아 적기는 바로 · AI 정리는 정해진 시간에", "정해진 시간에 모두 몰아서"])
        for p in [startPopup, endPopup] { p.addItems(withTitles: (0..<24).map { "\($0)시" }) }
        for p in [runPopup, startPopup, endPopup] { p.target = self; p.action = #selector(changed) }
        aiPopup.addItems(withTitles: ["자동 (로컬 모델이 켜져 있으면 로컬)", "로컬 모델 (Ollama)", "Claude Code"])
        aiPopup.target = self; aiPopup.action = #selector(changed)
        modelField.placeholderString = "자동 (MLX Qwen3.5-4B)"
        modelField.widthAnchor.constraint(equalToConstant: 180).isActive = true
        modelField.target = self; modelField.action = #selector(changed)
        calPopup.target = self; calPopup.action = #selector(changed)
        calPopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
        sincePicker.datePickerStyle = .textFieldAndStepper
        sincePicker.datePickerElements = [.yearMonthDay, .hourMinute]
        sincePicker.target = self; sincePicker.action = #selector(changed)
        modePopup.addItems(withTitles: ["새 대화가 오면 바로 (권장)", "정해진 간격마다", "둘 다"])
        modePopup.target = self; modePopup.action = #selector(changed)
        recordPopup.addItems(withTitles: ["자동 (권장)", "새 파일이 생기면 바로", "정해진 간격마다 확인", "둘 다"])
        recordPopup.target = self; recordPopup.action = #selector(changed)
        for f in [intervalField, pollField] { f.target = self; f.action = #selector(changed) }
        meField.placeholderString = "비우면 자동으로 찾아요 (예: 홍길동, 길동)"
        meField.widthAnchor.constraint(equalToConstant: 300).isActive = true
        meField.target = self; meField.action = #selector(changed)

        let general = page([
            header("녹취"),
            row([NSTextField(labelWithString: "폴더"), recordField, button("변경…", #selector(pickRecord)), button("열기", #selector(openRecord))]),
            row([skipOldCheck, sincePicker]),
            gap(),
            header("옵시디언"),
            row([NSTextField(labelWithString: "볼트"), vaultField, button("변경…", #selector(pickVault))]),
            row([button("옵시디언에 설치·업데이트", #selector(installObsidian)), button("대시보드 열기", #selector(openDashboard))]),
            obsidianState,
            gap(),
            header("앱"),
            loginCheck,
            row([NSTextField(labelWithString: "전체 디스크 접근 권한"), fdaState, button("시스템 설정 열기", #selector(openPrivacy))]),
            SettingsWindow.note("카카오톡 대화와 네트워크 드라이브의 녹취를 읽으려면 필요해요. 시스템 설정 목록에 Rappo 를 추가해 켜 주세요."),
        ])
        let kakao = page([
            kakaoCheck,
            SettingsWindow.note("카카오톡 맥 앱에 로그인되어 있어야 해요. 대화는 이 맥 안에서만 읽어요."),
            gap(),
            row([NSTextField(labelWithString: "가져오는 때"), modePopup]),
            row([NSTextField(labelWithString: "간격"), intervalField, NSTextField(labelWithString: "분마다")]),
            gap(),
            row([NSTextField(labelWithString: "내 카톡 이름"), meField]),
            SettingsWindow.note("대화에서 ‘나’로 표시할 이름이에요. 보통은 비워 두면 돼요."),
        ])
        let ai = page([
            header("정리 시간"),
            row([runPopup]),
            row([NSTextField(labelWithString: "정해진 시간"), startPopup, NSTextField(labelWithString: "부터"), endPopup, NSTextField(labelWithString: "까지")]),
            runNote,
            gap(),
            header("통화 요약 AI"),
            summaryCheck,
            row([NSTextField(labelWithString: "사용할 AI"), aiPopup]),
            row([NSTextField(labelWithString: "로컬 모델"), modelField, button("빈 요약 채우기", #selector(resummarize))]),
            aiState,
            SettingsWindow.note("로컬 모델은 이 맥 안에서만 돌아서 통화 내용이 밖으로 나가지 않아요. 기본은 Apple 실리콘용 MLX 로 돌리는 Qwen3.5 4B 예요 (필요할 때만 띄우고 끝나면 내려요)."),
            gap(),
            header("캘린더"),
            calCheck,
            row([NSTextField(labelWithString: "넣을 캘린더"), calPopup, button("접근 허용", #selector(allowCalendar))]),
            calState,
            SettingsWindow.note("구글 캘린더는 시스템 설정 › 인터넷 계정에 Google 계정을 추가하면 여기 목록에 나타나요. 넣은 일정은 구글 캘린더와 폰에도 동기화돼요."),
        ])
        let tools = page([
            header("도구"),
            row([button("지금 정리하기", #selector(runNow)), button("빈 요약 채우기", #selector(resummarize)), button("로그 보기", #selector(openLog))]),
            row([button("내 목소리 등록…", #selector(enroll))]),
            SettingsWindow.note("내 목소리만 녹음된 파일(10초 이상)을 등록하면 전사문에서 ‘나’와 상대를 구분해요."),
            gap(),
            header("녹취 폴더 확인 방식"),
            row([recordPopup, NSTextField(labelWithString: "확인 간격"), pollField, NSTextField(labelWithString: "분")]),
            watchState,
            SettingsWindow.note("NAS 같은 네트워크 드라이브는 새 파일을 바로 알 수 없어서, 자동이면 정해진 간격마다 확인해요."),
            gap(),
            header("카카오톡 내보내기 파일"),
            row([kakaoField, button("변경…", #selector(pickKakao))]),
            SettingsWindow.note("카톡에서 ‘대화 내보내기’로 받은 파일을 이 폴더에 넣으면 함께 정리해요. (맥 앱 대화는 자동이라 필요 없어요)"),
            gap(),
            button("모든 설정을 처음 값으로", #selector(resetDefaults)),
        ])

        let tabs = NSTabView()
        for (t, v) in [("일반", general), ("카카오톡", kakao), ("정리·AI·캘린더", ai), ("고급", tools)] {
            let it = NSTabViewItem(identifier: t); it.label = t; it.view = v; tabs.addTabViewItem(it)
        }
        tabs.translatesAutoresizingMaskIntoConstraints = false
        let cv = window!.contentView!
        cv.addSubview(tabs)
        NSLayoutConstraint.activate([
            tabs.topAnchor.constraint(equalTo: cv.topAnchor, constant: 12),
            tabs.leadingAnchor.constraint(equalTo: cv.leadingAnchor, constant: 12),
            tabs.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -12),
            tabs.bottomAnchor.constraint(equalTo: cv.bottomAnchor, constant: -12),
            tabs.widthAnchor.constraint(equalToConstant: 580),
            tabs.heightAnchor.constraint(equalToConstant: 600),
        ])
    }

    static let fmt: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm"; f.locale = Locale(identifier: "en_US_POSIX"); return f }()

    // 설정 값 → 화면
    func load() {
        recordField.stringValue = s.recordDir
        vaultField.stringValue = s.vaultDir
        kakaoField.stringValue = s.kakaoDir.isEmpty ? "(지정 안 함)" : s.kakaoDir
        let since = SettingsWindow.fmt.date(from: s.since)
        skipOldCheck.state = since == nil ? .off : .on
        sincePicker.dateValue = since ?? Date()
        summaryCheck.state = s.summary ? .on : .off
        kakaoCheck.state = s.kakaoOn ? .on : .off
        modePopup.selectItem(at: s.kakaoMode.rawValue)
        intervalField.integerValue = s.intervalMin
        meField.stringValue = s.kakaoMe
        recordPopup.selectItem(at: s.recordMode.rawValue)
        pollField.integerValue = s.pollMin
        runPopup.selectItem(at: s.runMode)
        startPopup.selectItem(at: s.winStart)
        endPopup.selectItem(at: s.winEnd)
        aiPopup.selectItem(at: s.aiEngine)
        modelField.stringValue = s.aiModel
        calCheck.state = s.calOn ? .on : .off
        fillCalendars()
        refreshStatus()
    }

    func fillCalendars() {
        calPopup.removeAllItems()
        let cals = app?.writableCalendars() ?? []
        if cals.isEmpty { calPopup.addItem(withTitle: "(접근 허용을 눌러 주세요)"); calPopup.isEnabled = false; return }
        calPopup.isEnabled = true
        for c in cals { calPopup.addItem(withTitle: app!.calLabel(c)); calPopup.lastItem?.representedObject = c.calendarIdentifier }
        if let i = cals.firstIndex(where: { $0.calendarIdentifier == s.calId }) { calPopup.selectItem(at: i) }
        else if let g = cals.firstIndex(where: { $0.source.title.localizedCaseInsensitiveContains("google") || $0.source.title.contains("@gmail") }) {
            calPopup.selectItem(at: g); s.calId = cals[g].calendarIdentifier
        } else { s.calId = cals[0].calendarIdentifier }
    }
    @objc func allowCalendar() {
        app?.requestCalendar { [weak self] ok in
            guard let self = self else { return }
            if ok { self.s.calOn = true; self.load(); self.app?.syncCalendar() }
            else { self.app?.alert("캘린더 접근이 막혀 있어요", "시스템 설정 › 개인정보 보호 및 보안 › 캘린더에서 Rappo 를 켜 주세요."); self.refreshStatus() }
        }
    }

    // 상태 표시 (권한·로그인·옵시디언·감시 방식)
    func refreshStatus() {
        guard let app = app else { return }
        loginCheck.state = app.loginEnabled ? .on : .off
        let ok = app.hasFullDiskAccess
        fdaState.stringValue = ok ? "✅ 허용됨" : "⚠️ 필요해요"
        fdaState.textColor = ok ? .systemGreen : .systemOrange
        let hasVault = FileManager.default.fileExists(atPath: s.vaultDir + "/.obsidian")
        let hasDash = FileManager.default.fileExists(atPath: app.dashboardPath)
        obsidianState.stringValue = !hasVault ? "⚠️ 이 폴더는 옵시디언 볼트가 아니에요. ‘변경…’으로 볼트를 골라 주세요."
            : hasDash ? "✅ 대시보드: \(s.baseDir)/라포 홈" : "아직 설치 전이에요. ‘옵시디언에 설치·업데이트’를 눌러 주세요."
        watchState.stringValue = "지금: " + app.recordLine.title.replacingOccurrences(of: "녹취: ", with: "")
        let k = s.kakaoOn
        modePopup.isEnabled = k
        meField.isEnabled = k
        intervalField.isEnabled = k && s.kakaoMode != .change
        pollField.isEnabled = s.recordMode != .change
        sincePicker.isEnabled = skipOldCheck.state == .on
        startPopup.isEnabled = s.runMode != 0
        endPopup.isEnabled = s.runMode != 0
        runNote.stringValue = [
            "새 녹취·카톡·회의가 들어오면 바로 받아 적고 AI 로 정리해요.",
            "받아 적기와 카톡 가져오기는 바로, 요약·할 일·회의록 같은 AI 정리는 \(s.winStart)시~\(s.winEnd)시에 몰아서 해요. 낮에는 맥이 가벼워요.",
            "모든 정리를 \(s.winStart)시~\(s.winEnd)시에 몰아서 해요. 그 사이 맥이 깨어 있어야 해요 (잠자기면 깨어난 뒤 그 시간대에).",
        ][max(0, min(2, s.runMode))] + " ‘지금 정리하기’를 누르면 언제든 바로 해요."
        let access = app.calAccess
        calState.stringValue = !access ? "⚠️ 캘린더 접근을 허용해 주세요." : !s.calOn ? "꺼져 있어요." :
            "✅ 켜짐 · 지금까지 \((UserDefaults.standard.dictionary(forKey: "calAdded") ?? [:]).count)개 넣음"
        let mlxPy = NSHomeDirectory() + "/.venvs/mlx-llm/bin/python"
        if FileManager.default.fileExists(atPath: mlxPy) {
            aiState.stringValue = "✅ 로컬 모델 준비됨 (MLX · " + (s.aiModel.isEmpty ? "Qwen3.5-4B" : s.aiModel) + ")"
        } else {
            aiState.stringValue = "로컬 모델 확인 중…"
            let model = s.aiModel.isEmpty ? "qwen3.5:4b" : s.aiModel
            app.ollamaState { [weak self] up, names in
                self?.aiState.stringValue = !up ? "⚠️ 로컬 모델이 없어요. 터미널: bash ~/Documents/Rappo/install.sh 에서 로컬 AI 설치를 골라 주세요"
                    : names.contains(where: { $0 == model || $0 == model + ":latest" }) ? "✅ 로컬 모델 준비됨 (Ollama · \(model))"
                    : "⚠️ 모델이 없어요. 터미널: ollama pull \(model)"
            }
        }
    }

    // 화면 → 설정 값 (바꾸면 바로 적용)
    @objc func changed() {
        s.since = skipOldCheck.state == .on ? SettingsWindow.fmt.string(from: sincePicker.dateValue) : ""
        s.summary = summaryCheck.state == .on
        s.kakaoOn = kakaoCheck.state == .on
        s.kakaoMode = KakaoMode(rawValue: modePopup.indexOfSelectedItem) ?? .change
        s.intervalMin = max(5, intervalField.integerValue)
        s.kakaoMe = meField.stringValue.trimmingCharacters(in: .whitespaces)
        s.recordMode = RecordMode(rawValue: recordPopup.indexOfSelectedItem) ?? .auto
        s.pollMin = max(1, pollField.integerValue)
        s.runMode = runPopup.indexOfSelectedItem
        s.winStart = startPopup.indexOfSelectedItem
        s.winEnd = endPopup.indexOfSelectedItem
        s.aiEngine = aiPopup.indexOfSelectedItem
        let m = modelField.stringValue.trimmingCharacters(in: .whitespaces)
        s.aiModel = m
        s.calOn = calCheck.state == .on
        if let id = calPopup.selectedItem?.representedObject as? String { s.calId = id }
        if s.calOn { app?.syncCalendar() }
        if let app = app, (loginCheck.state == .on) != app.loginEnabled { app.toggleLogin() }
        app?.applySettings()
        refreshStatus()
    }

    func pick(_ title: String, _ current: String, _ done: @escaping (String) -> Void) {
        let p = NSOpenPanel()
        p.message = title
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.canCreateDirectories = true
        if !current.isEmpty { p.directoryURL = URL(fileURLWithPath: current) }
        p.beginSheetModal(for: window!) { r in
            if r == .OK, let u = p.url { done(u.path) }
        }
    }
    // config.sh 와 같은 값이면 저장하지 않는다 (config.sh 를 따라가도록)
    func store(_ v: String, _ envKey: String) -> String { v == (s.base[envKey] ?? "") ? "" : v }

    @objc func pickRecord() {
        pick("통화 녹음 파일이 모이는 폴더를 고르세요", s.recordDir) { [self] path in
            guard path != s.recordDir else { return }
            s.recordDir = store(path, "RAPPO_RECORD")
            // 새 폴더의 기존 녹취는 건너뛰도록 지금 시각부터
            if s.since.isEmpty { s.since = Settings.nowStamp() }
            load(); app?.applySettings(); refreshStatus()
        }
    }
    @objc func pickVault() {
        pick("옵시디언 볼트 폴더를 고르세요", s.vaultDir) { [self] path in
            s.vaultDir = store(path, "RAPPO_VAULT"); load()
        }
    }
    @objc func pickKakao() {
        pick("카카오톡 ‘대화 내보내기’ 파일을 넣을 폴더를 고르세요", s.kakaoDir) { [self] path in
            s.kakaoDir = store(path, "RAPPO_KAKAO"); load(); app?.applySettings()
        }
    }
    @objc func openRecord() { app?.openRecord() }
    @objc func installObsidian() { app?.setupObsidian() }
    @objc func openDashboard() { app?.openDashboard() }
    @objc func openPrivacy() { app?.openPrivacy() }
    @objc func runNow() { app?.runNow() }
    @objc func resummarize() { app?.runResummarize() }
    @objc func openLog() { app?.openLog() }
    @objc func enroll() { app?.enrollVoice() }

    @objc func resetDefaults() {
        let a = NSAlert()
        a.messageText = "모든 설정을 처음 값으로 되돌릴까요?"
        a.informativeText = "녹취·볼트 폴더는 설치할 때 정한 값으로 돌아갑니다. 노트는 그대로예요."
        a.addButton(withTitle: "되돌리기"); a.addButton(withTitle: "취소")
        a.beginSheetModal(for: window!) { [self] r in
            guard r == .alertFirstButtonReturn else { return }
            s.reset(); load(); app?.applySettings()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
