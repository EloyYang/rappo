// Rappo(라포) 메뉴막대 앱 — 녹취·카카오톡을 옵시디언 노트로.
// - 녹취 폴더를 감시해 새 파일이 들어오면 run.sh 실행
// - 카카오톡: DB 파일이 바뀌면(변경 감지) 그리고/또는 일정 주기로 run.sh --kakao-db 실행
// - 설정 창에서 폴더·반영 방식 등을 바꾸면 run.sh 에 APP_RAPPO_* 환경변수로 전달
// - 앱이 직접 python 을 띄우므로, '전체 디스크 접근 권한'은 이 앱 하나에만 주면 된다.
import Cocoa
import ServiceManagement
import UniformTypeIdentifiers

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
                              "quietSec": 60, "minGapMin": 5, "summary": true, "pollMin": 5, "recordMode": 0])
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

    static let keys = ["recordDir", "vaultDir", "kakaoDir", "kakaoMe", "kakaoMode", "intervalMin", "quietSec", "minGapMin", "summary", "since", "pollMin", "recordMode"]
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

    func applicationDidFinishLaunching(_ n: Notification) {
        codeDir = Bundle.main.infoDictionary?["CNCodeDir"] as? String ?? ""
        s = Settings(codeDir: codeDir)
        buildMenu()
        setIcon(busy: false)
        applySettings()
        // 시작 직후 한 번 (동기화가 붙을 시간을 조금 준다)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.request(["--kakao-db"]) }
    }

    // 이미 실행 중일 때 앱을 다시 열면(Finder 더블클릭 등) 설정 창
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openSettings()
        return false
    }

    // 설정이 바뀔 때마다 감시·타이머를 다시 건다
    func applySettings() {
        watchers.removeAll()
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
        for m in [statusLine, lastLine, recordLine, modeLine] { m.isEnabled = false; menu.addItem(m) }
        menu.addItem(.separator())
        add("지금 실행 (녹취 + 카톡)", #selector(runNow), "r")
        add("녹취만 처리", #selector(runRecordings), "")
        add("빈 요약 채우기", #selector(runResummarize), "")
        menu.addItem(.separator())
        add("설정…", #selector(openSettings), ",")
        add("로그 보기", #selector(openLog), "l")
        add("녹취 폴더 열기", #selector(openRecord), "")
        add("통화기록 폴더 열기", #selector(openNotes), "")
        menu.addItem(.separator())
        add("옵시디언에 대시보드·검색 설치", #selector(setupObsidian), "")
        add("내 목소리 등록…", #selector(enrollVoice), "")
        menu.addItem(.separator())
        loginItem.target = self
        menu.addItem(loginItem)
        add("전체 디스크 접근 권한 설정…", #selector(openPrivacy), "")
        menu.addItem(.separator())
        add("종료", #selector(quit), "q")
        menu.delegate = self
        item.menu = menu
    }

    func add(_ title: String, _ sel: Selector, _ key: String) {
        let m = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        m.target = self
        menu.addItem(m)
    }

    func menuWillOpen(_ menu: NSMenu) {
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    func setIcon(busy: Bool) {
        let name = busy ? "arrow.triangle.2.circlepath" : "phone.bubble"
        let img = NSImage(systemSymbolName: name, accessibilityDescription: "Rappo")
        img?.isTemplate = true
        item.button?.image = img
        statusLine.title = busy ? "처리 중…" : "대기 중"
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
        statusLine.title = running == nil ? "카톡 변경 감지 — 대기 중" : statusLine.title
    }

    // MARK: 실행

    func request(_ args: [String]) {
        var args = args
        if !s.summary && !args.contains("--resummarize") { args.append("--no-summary") }
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
        let f = DateFormatter()
        f.dateFormat = "M/d HH:mm"
        let ok = p.terminationStatus == 0 ? "" : " (오류 \(p.terminationStatus) — 로그 확인)"
        lastLine.title = "마지막 실행: \(f.string(from: Date()))\(ok)"
        let a = p.arguments ?? []
        if a.contains("--setup-obsidian") {
            if p.terminationStatus == 0 {
                alert("옵시디언 설치 완료", "볼트에 '\(s.baseDir)/통화기록 대시보드'와 검색 플러그인을 넣었습니다.\n옵시디언을 다시 열고, 물어보면 '플러그인 사용(신뢰)'을 눌러 주세요.")
            } else { alert("옵시디언 설치 실패", "로그 보기에서 내용을 확인해 주세요.") }
        } else if a.contains("--enroll") {
            alert(p.terminationStatus == 0 ? "내 목소리를 등록했습니다" : "목소리 등록 실패", p.terminationStatus == 0 ? "다음 통화부터 '나'를 구분합니다." : "로그 보기에서 내용을 확인해 주세요.")
        }
        if let next = pendingArgs {
            pendingArgs = nil
            request(next)
        }
    }

    @objc func runNow() { request(["--kakao-db"]) }
    @objc func runRecordings() { request([]) }
    @objc func runResummarize() { request(["--resummarize"]) }

    // MARK: 열기

    @objc func openSettings() {
        if settingsWC == nil {
            settingsWC = SettingsWindow(settings: s) { [weak self] in self?.applySettings() }
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
    let onSave: () -> Void

    let recordField = SettingsWindow.pathLabel()
    let vaultField = SettingsWindow.pathLabel()
    let kakaoField = SettingsWindow.pathLabel()
    let meField = NSTextField()
    let modePopup = NSPopUpButton()
    let intervalField = SettingsWindow.numField()
    let quietField = SettingsWindow.numField()
    let gapField = SettingsWindow.numField()
    let sinceField = NSTextField()
    let pollField = SettingsWindow.numField()
    let recordPopup = NSPopUpButton()
    let summaryCheck = NSButton(checkboxWithTitle: "Claude 로 통화 요약 만들기", target: nil, action: nil)

    init(settings: Settings, onSave: @escaping () -> Void) {
        s = settings
        self.onSave = onSave
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 420),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Rappo 설정"
        w.isReleasedWhenClosed = false
        super.init(window: w)
        build()
        if let v = w.contentView { w.setContentSize(v.fittingSize) }
        w.center()
    }
    required init?(coder: NSCoder) { fatalError() }

    static func pathLabel() -> NSTextField {
        let f = NSTextField(labelWithString: "")
        f.lineBreakMode = .byTruncatingMiddle
        f.textColor = .secondaryLabelColor
        f.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        f.widthAnchor.constraint(equalToConstant: 360).isActive = true
        return f
    }
    static func numField() -> NSTextField {
        let f = NSTextField()
        f.alignment = .right
        f.widthAnchor.constraint(equalToConstant: 60).isActive = true
        let nf = NumberFormatter(); nf.allowsFloats = false; nf.minimum = 0
        f.formatter = nf
        return f
    }

    func folderRow(_ title: String, _ field: NSTextField, _ sel: Selector) -> [NSView] {
        let b = NSButton(title: "변경…", target: self, action: sel)
        let row = NSStackView(views: [field, b])
        row.spacing = 8
        return [NSTextField(labelWithString: title), row]
    }
    func numRow(_ title: String, _ field: NSTextField, _ unit: String) -> [NSView] {
        let row = NSStackView(views: [field, NSTextField(labelWithString: unit)])
        row.spacing = 6
        return [NSTextField(labelWithString: title), row]
    }

    func sinceRow() -> [NSView] {
        sinceField.placeholderString = "비우면 전부 처리"
        sinceField.widthAnchor.constraint(equalToConstant: 160).isActive = true
        let b = NSButton(title: "지금부터", target: self, action: #selector(sinceNow))
        let row = NSStackView(views: [sinceField, b, NSTextField(labelWithString: "이후 통화만")])
        row.spacing = 8
        return [NSTextField(labelWithString: "처리 시작 시각"), row]
    }
    @objc func sinceNow() { sinceField.stringValue = Settings.nowStamp() }

    func build() {
        recordPopup.addItems(withTitles: ["자동 (로컬=변경 감지, 네트워크 드라이브=주기 확인)",
                                          "새 파일이 생기면 바로 (변경 감지)", "일정 주기로 새 파일 확인", "변경 감지 + 주기 확인"])
        recordPopup.target = self
        recordPopup.action = #selector(modeChanged)
        modePopup.addItems(withTitles: ["DB 파일이 바뀔 때만 (변경 감지)", "일정 주기로", "변경 감지 + 주기"])
        modePopup.target = self
        modePopup.action = #selector(modeChanged)
        meField.placeholderString = "예: 홍길동, 길동  (쉼표로 구분, 비우면 자동)"

        let note = NSTextField(wrappingLabelWithString:
            "변경 감지: 카카오톡 맥 앱이 새 메시지를 받아 DB 파일이 바뀌면, 변화가 멈춘 뒤 ‘대기’ 시간만큼 기다렸다가 반영합니다. " +
            "대화가 이어질 때 너무 자주 돌지 않도록 ‘최소 간격’을 둡니다. 카카오톡 앱이 꺼져 있으면 DB 가 바뀌지 않으므로 반영도 없습니다.\n" +
            "녹취: 네트워크 드라이브(/Volumes 의 NAS 등)는 다른 기기가 넣은 파일을 맥이 알려주지 않아 변경 감지가 동작하지 않습니다. " +
            "‘자동’은 이런 폴더에서 주기 확인으로 바꿔 줍니다. 주기 확인도 새 파일이 있을 때만 처리합니다.")
        note.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        note.textColor = .secondaryLabelColor
        note.preferredMaxLayoutWidth = 560

        let grid = NSGridView(views: [
            folderRow("녹취 폴더", recordField, #selector(pickRecord)),
            sinceRow(),
            [NSTextField(labelWithString: "녹취 감지 방식"), recordPopup],
            numRow("새 파일 확인", pollField, "분마다 (주기 확인을 쓸 때)"),
            folderRow("옵시디언 볼트", vaultField, #selector(pickVault)),
            folderRow("카톡 내보내기 폴더", kakaoField, #selector(pickKakao)),
            [NSTextField(labelWithString: "내 카톡 이름"), meField],
            [NSTextField(labelWithString: "카톡 반영 방식"), modePopup],
            numRow("주기", intervalField, "분마다"),
            numRow("변경 후 대기", quietField, "초 (변화가 멈춘 뒤)"),
            numRow("최소 간격", gapField, "분 (연속 실행 방지)"),
            [NSGridCell.emptyContentView, summaryCheck],
        ])
        grid.rowSpacing = 10
        grid.columnSpacing = 12
        grid.column(at: 0).xPlacement = .trailing
        grid.rowAlignment = .firstBaseline

        let reset = NSButton(title: "기본값으로", target: self, action: #selector(resetDefaults))
        let cancel = NSButton(title: "취소", target: self, action: #selector(cancel))
        cancel.keyEquivalent = "\u{1b}"
        let save = NSButton(title: "저장", target: self, action: #selector(save))
        save.keyEquivalent = "\r"
        let spacer = NSView()
        let buttons = NSStackView(views: [reset, spacer, cancel, save])
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)

        let stack = NSStackView(views: [grid, note, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        buttons.widthAnchor.constraint(equalTo: grid.widthAnchor).isActive = true

        let v = window!.contentView!
        v.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: v.topAnchor),
            stack.leadingAnchor.constraint(equalTo: v.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: v.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: v.bottomAnchor),
        ])
    }

    func load() {
        recordField.stringValue = s.recordDir
        vaultField.stringValue = s.vaultDir
        kakaoField.stringValue = s.kakaoDir
        meField.stringValue = s.kakaoMe
        modePopup.selectItem(at: s.kakaoMode.rawValue)
        intervalField.integerValue = s.intervalMin
        quietField.integerValue = s.quietSec
        gapField.integerValue = s.minGapMin
        summaryCheck.state = s.summary ? .on : .off
        sinceField.stringValue = s.since
        pollField.integerValue = s.pollMin
        recordPopup.selectItem(at: s.recordMode.rawValue)
        modeChanged()
    }

    @objc func modeChanged() {
        let m = KakaoMode(rawValue: modePopup.indexOfSelectedItem) ?? .change
        intervalField.isEnabled = m != .change
        quietField.isEnabled = m != .interval
        gapField.isEnabled = m != .interval
        let r = RecordMode(rawValue: recordPopup.indexOfSelectedItem) ?? .auto
        pollField.isEnabled = r != .change
    }

    func pick(_ field: NSTextField) {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.canCreateDirectories = true
        if !field.stringValue.isEmpty { p.directoryURL = URL(fileURLWithPath: field.stringValue) }
        p.beginSheetModal(for: window!) { r in
            if r == .OK, let u = p.url { field.stringValue = u.path }
        }
    }
    @objc func pickRecord() { pick(recordField) }
    @objc func pickVault() { pick(vaultField) }
    @objc func pickKakao() { pick(kakaoField) }

    @objc func resetDefaults() {
        s.reset()
        load()
        onSave()
    }
    @objc func cancel() { window?.close() }

    @objc func save() {
        let since = sinceField.stringValue.trimmingCharacters(in: .whitespaces)
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm"; f.locale = Locale(identifier: "en_US_POSIX")
        if !since.isEmpty && f.date(from: since) == nil {
            let a = NSAlert()
            a.messageText = "처리 시작 시각 형식이 맞지 않습니다"
            a.informativeText = "예: 2026-11-26 01:30  (비우면 전부 처리)"
            a.beginSheetModal(for: window!)
            return
        }
        // 녹취 폴더를 바꿨는데 시작 시각을 비워 두면, 기존 파일은 건너뛰도록 지금 시각으로
        let recordChanged = recordField.stringValue != s.recordDir
        s.since = (recordChanged && since.isEmpty) ? Settings.nowStamp() : since
        s.pollMin = pollField.integerValue
        s.recordMode = RecordMode(rawValue: recordPopup.indexOfSelectedItem) ?? .auto
        // config.sh 와 같은 값이면 저장하지 않는다 (config.sh 를 따라가도록)
        func store(_ v: String, _ envKey: String) -> String { v == (s.base[envKey] ?? "") ? "" : v }
        s.recordDir = store(recordField.stringValue, "RAPPO_RECORD")
        s.vaultDir = store(vaultField.stringValue, "RAPPO_VAULT")
        s.kakaoDir = store(kakaoField.stringValue, "RAPPO_KAKAO")
        s.kakaoMe = meField.stringValue.trimmingCharacters(in: .whitespaces)
        s.kakaoMode = KakaoMode(rawValue: modePopup.indexOfSelectedItem) ?? .change
        s.intervalMin = intervalField.integerValue
        s.quietSec = quietField.integerValue
        s.minGapMin = gapField.integerValue
        s.summary = summaryCheck.state == .on
        onSave()
        window?.close()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
