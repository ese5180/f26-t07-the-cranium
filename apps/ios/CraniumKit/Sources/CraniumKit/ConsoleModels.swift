import Foundation

// The console's answers about boards, deployments, the activity log, events and API tokens,
// read as the website reads them (cloud/web/src/site/assets/core.js).

/// A board as it last reported, from its shadow (`GET /api/devices`, cloud/api/src/lib/shadow.mjs).
public struct Device: Decodable, Equatable, Sendable, Identifiable {
    public struct Firmware: Decodable, Equatable, Sendable {
        public let version: String
        public let confirmed: Bool

        public init(version: String, confirmed: Bool) {
            self.version = version
            self.confirmed = confirmed
        }
    }

    /// What the board last said about updates.
    public struct OTA: Decodable, Equatable, Sendable {
        /// idle, awaiting_user, downloading, verifying, rebooting, testing, bluetooth
        public let state: String
        /// The deployment it works on, if it is one of this console's.
        public let job: String?
        public let progress: Int
        /// How its last update ended: none, succeeded, failed, rolled_back, declined, refused, cancelled.
        public let last: String
        /// Its reason code, when the last update failed or was refused.
        public let error: String

        public init(state: String, job: String? = nil, progress: Int = 0, last: String = "none", error: String = "") {
            self.state = state
            self.job = job
            self.progress = progress
            self.last = last
            self.error = error
        }

        private enum CodingKeys: String, CodingKey { case state, job, progress, last, error }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let said = c.boardText(.state, limit: 24)
            state = said.isEmpty ? "idle" : said
            job = c.lenient(String.self, .job).flatMap { DeploymentId.isValid($0) ? $0 : nil }
            progress = c.whole(.progress, 0, 100) ?? 0
            let last = c.boardText(.last, limit: 24)
            self.last = last.isEmpty ? "none" : last
            error = c.boardText(.error, limit: 64)
        }
    }

    /// How often the board restarted itself for being stuck, and why the last time (from 1.7.0).
    public struct Stuck: Decodable, Equatable, Sendable {
        public let count: Int
        public let reason: String

        public init(count: Int, reason: String) {
            self.count = count
            self.reason = reason
        }
    }

    public struct Heap: Decodable, Equatable, Sendable {
        public let free: Int
        public let least: Int
        public let size: Int

        public init(free: Int, least: Int, size: Int) {
            self.free = free
            self.least = least
            self.size = size
        }
    }

    /// The diagnostics report, every 5 minutes from 1.10.0.
    public struct Diag: Decodable, Equatable, Sendable {
        public let mac: String?
        public let channel: Int?
        public let heap: Heap?
        /// When AWS IoT received it.
        public let at: String?

        public init(mac: String?, channel: Int?, heap: Heap?, at: String? = nil) {
            self.mac = mac
            self.channel = channel
            self.heap = heap
            self.at = at
        }

        private enum CodingKeys: String, CodingKey { case mac, channel, heap, at }
        private enum HeapKeys: String, CodingKey { case free, least, size }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let mac = c.lenient(String.self, .mac) ?? ""
            self.mac = mac.range(of: "^[0-9a-f]{2}(:[0-9a-f]{2}){5}$", options: .regularExpression) != nil ? mac : nil
            channel = c.whole(.channel, 0, 233)
            if let h = try? c.nestedContainer(keyedBy: HeapKeys.self, forKey: .heap),
               let free = h.whole(.free, 0, 1 << 31), let least = h.whole(.least, 0, 1 << 31),
               let size = h.whole(.size, 1, 1 << 31), free <= size, least <= size {
                heap = Heap(free: free, least: least, size: size)
            } else {
                heap = nil
            }
            at = c.instant(.at)
        }
    }

    /// One boot of the diary: its version, why the boot before it ended (hex, and by name), how far it got.
    public struct Boot: Decodable, Equatable, Sendable {
        public let version: String
        public let cause: String
        public let causes: [String]
        public let stage: Int

        public init(version: String, cause: String, causes: [String], stage: Int) {
            self.version = version
            self.cause = cause
            self.causes = causes
            self.stage = stage
        }
    }

    /// The boot diary, newest boot first (from 1.7.4).
    public struct Diary: Decodable, Equatable, Sendable {
        public let boots: Int
        public let entries: [Boot]

        public init(boots: Int, entries: [Boot]) {
            self.boots = boots
            self.entries = entries
        }

        private enum CodingKeys: String, CodingKey { case boots, entries }
        private enum BootKeys: String, CodingKey { case version, cause, causes, stage }
        static let resetNames: Set<String> = ["pin", "software", "brownout", "power_on", "watchdog", "debugger",
                                              "security", "wake", "lockup", "parity", "pll", "clock", "hardware",
                                              "user", "temperature", "unknown"]

        struct Entry: Decodable {
            let boot: Boot?
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: BootKeys.self)
                let cause = c.lenient(String.self, .cause) ?? ""
                guard let version = c.version(.version),
                      cause.range(of: "^[0-9a-f]{1,8}$", options: .regularExpression) != nil,
                      let stage = c.whole(.stage, 0, 255) else {
                    boot = nil
                    return
                }
                let causes = c.texts(.causes, limit: 16).filter { Diary.resetNames.contains($0) }
                boot = Boot(version: version, cause: cause, causes: causes, stage: stage)
            }
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            guard let boots = c.whole(.boots, 0, 1 << 32) else {
                throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "no boots"))
            }
            self.boots = boots
            let list = try c.decode(LenientList<Entry>.self, forKey: .entries).items
            entries = Array(list.compactMap(\.boot).prefix(16))
        }
    }

    /// The board's record of its last update over Bluetooth (from 1.9.0).
    public struct BluetoothRecord: Decodable, Equatable, Sendable {
        public let from: String
        public let to: String
        /// pending, succeeded, rolled_back, not_installed, trial_lost, superseded, flash_error
        public let result: String
        /// none, cloud, person
        public let proof: String
        public let count: Int

        public init(from: String, to: String, result: String, proof: String = "none", count: Int = 0) {
            self.from = from
            self.to = to
            self.result = result
            self.proof = proof
            self.count = count
        }

        static let results: Set<String> = ["pending", "succeeded", "rolled_back", "not_installed", "trial_lost",
                                           "superseded", "flash_error"]
        private enum CodingKeys: String, CodingKey { case from, to, result, proof, count }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            guard let from = c.version(.from), let to = c.version(.to),
                  let result = c.lenient(String.self, .result), Self.results.contains(result) else {
                throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not a record"))
            }
            self.from = from
            self.to = to
            self.result = result
            let proof = c.lenient(String.self, .proof) ?? ""
            self.proof = ["cloud", "person"].contains(proof) ? proof : "none"
            count = c.whole(.count, 0, 1 << 32) ?? 0
        }
    }

    public let thing: String
    /// The person-given device ID the board reports from firmware 1.11.4 (1 to 32 letters and digits,
    /// such as CRVIHAAN01), or nil before it has. Only for showing: `thing` names the board in every call.
    public let name: String?
    public let online: Bool
    /// When AWS IoT received its last heartbeat.
    public let lastSeen: String?
    public let fw: Firmware?
    public let ota: OTA?
    public let rssi: Int?
    /// Seconds since it started, as of its last heartbeat.
    public let uptime: Int?
    public let stuck: Stuck?
    public let diag: Diag?
    public let diary: Diary?
    public let bt: BluetoothRecord?

    public var id: String { thing }

    public init(thing: String, name: String? = nil, online: Bool = false, lastSeen: String? = nil, fw: Firmware? = nil,
                ota: OTA? = nil, rssi: Int? = nil, uptime: Int? = nil, stuck: Stuck? = nil, diag: Diag? = nil,
                diary: Diary? = nil, bt: BluetoothRecord? = nil) {
        self.thing = thing
        self.name = name.flatMap(Self.validName)
        self.online = online
        self.lastSeen = lastSeen
        self.fw = fw
        self.ota = ota
        self.rssi = rssi
        self.uptime = uptime
        self.stuck = stuck
        self.diag = diag
        self.diary = diary
        self.bt = bt
    }

    private enum CodingKeys: String, CodingKey { case thing, name, online, lastSeen, fw, ota, rssi, uptime, stuck, diag, diary, bt }

    /// A device ID as the board reports it: 1 to 32 letters and digits. Anything else is no name.
    static func validName(_ text: String) -> String? {
        text.range(of: "^[A-Za-z0-9]{1,32}$", options: .regularExpression) != nil ? text : nil
    }

    /// What to call the board: its device ID, or its thing name until it has reported one.
    public var label: String { name ?? thing }
    private enum FirmwareKeys: String, CodingKey { case version, confirmed }
    private enum StuckKeys: String, CodingKey { case count, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        thing = c.text(.thing, limit: 64)
        name = c.lenient(String.self, .name).flatMap(Self.validName)
        online = c.bool(.online)
        lastSeen = c.instant(.lastSeen)
        if let f = try? c.nestedContainer(keyedBy: FirmwareKeys.self, forKey: .fw), let version = f.version(.version) {
            fw = Firmware(version: version, confirmed: f.bool(.confirmed))
        } else {
            fw = nil
        }
        ota = c.lenient(OTA.self, .ota)
        rssi = c.whole(.rssi, -127, 0)
        uptime = c.whole(.uptime, 0, 1 << 32)
        if let s = try? c.nestedContainer(keyedBy: StuckKeys.self, forKey: .stuck), let count = s.whole(.count, 0, 1 << 32),
           let reason = s.lenient(String.self, .reason),
           reason.range(of: "^[a-z][a-z_]{0,31}$", options: .regularExpression) != nil {
            stuck = Stuck(count: count, reason: reason)
        } else {
            stuck = nil
        }
        diag = c.lenient(Diag.self, .diag)
        diary = c.lenient(Diary.self, .diary)
        bt = c.lenient(BluetoothRecord.self, .bt)
    }
}

/// `GET /api/devices`.
public struct DeviceList: Decodable, Equatable, Sendable {
    public let devices: [Device]
    public let generatedAt: String?

    public init(devices: [Device], generatedAt: String? = nil) {
        self.devices = devices
        self.generatedAt = generatedAt
    }

    private enum CodingKeys: String, CodingKey { case devices, generatedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        devices = try c.decode(LenientList<Device>.self, forKey: .devices).items.filter { !$0.thing.isEmpty }
        generatedAt = c.instant(.generatedAt)
    }
}

/// One update a board was offered, in its own history (`GET /api/devices/{thing}`).
public struct ExecutionSummary: Decodable, Equatable, Sendable, Identifiable {
    public let deployment: String
    /// Nil for a job some other tool created on the board.
    public let version: String?
    public let status: String
    public let queuedAt: String?
    public let startedAt: String?
    public let lastUpdatedAt: String?

    public var id: String { deployment }

    public init(deployment: String, version: String?, status: String, queuedAt: String? = nil,
                startedAt: String? = nil, lastUpdatedAt: String? = nil) {
        self.deployment = deployment
        self.version = version
        self.status = status
        self.queuedAt = queuedAt
        self.startedAt = startedAt
        self.lastUpdatedAt = lastUpdatedAt
    }

    private enum CodingKeys: String, CodingKey { case deployment, version, status, queuedAt, startedAt, lastUpdatedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deployment = c.text(.deployment, limit: 64)
        version = c.version(.version)
        status = c.text(.status, limit: 24)
        queuedAt = c.instant(.queuedAt)
        startedAt = c.instant(.startedAt)
        lastUpdatedAt = c.instant(.lastUpdatedAt)
    }
}

/// `GET /api/devices/{thing}`: the board, its certificates, and its updates, newest first.
public struct DeviceDetail: Decodable, Equatable, Sendable {
    public let device: Device
    /// The first 16 hex digits of each certificate attached to it.
    public let certificates: [String]
    public let executions: [ExecutionSummary]
    /// How many older updates the server left out.
    public let olderExecutions: Int
    /// Its newest update of any kind (console 2.1.1 and later); nil from an older console, or when it has had none.
    public let lastUpdate: BoardUpdate?

    public init(device: Device, certificates: [String] = [], executions: [ExecutionSummary] = [], olderExecutions: Int = 0,
                lastUpdate: BoardUpdate? = nil) {
        self.device = device
        self.certificates = certificates
        self.executions = executions
        self.olderExecutions = olderExecutions
        self.lastUpdate = lastUpdate
    }

    private enum CodingKeys: String, CodingKey { case device, certificates, executions, olderExecutions, lastUpdate }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        device = try c.decode(Device.self, forKey: .device)
        certificates = c.texts(.certificates).map { Lenient.boardText($0) }
        executions = try c.decode(LenientList<ExecutionSummary>.self, forKey: .executions).items
        olderExecutions = c.whole(.olderExecutions, 0, 1 << 32) ?? 0
        lastUpdate = c.lenient(BoardUpdate.self, .lastUpdate)
    }
}

/// One update of one board (`GET /api/updates`, console 2.1.1 and later): a deployment's execution on
/// it, or an update the board reported itself, over Bluetooth, or by USB or another tool.
public struct BoardUpdate: Decodable, Equatable, Sendable, Identifiable {
    /// How it came. Anything this app has no words for is taken for USB or another tool.
    public enum How: String, Sendable, CaseIterable {
        case deployment
        case bluetooth
        case usbOrOther = "usb_or_other"
    }

    /// How it ended. Anything this app has no words for is taken for not ended yet.
    public enum Outcome: String, Sendable, CaseIterable {
        case kept
        case rolledBack = "rolled_back"
        case notInstalled = "not_installed"
        case pending
    }

    /// Over Bluetooth, the person whose phone made the check before the send; for a deployment, who
    /// started it.
    public struct Who: Decodable, Equatable, Sendable {
        public let sub: String
        public let email: String
        /// The console's short name for the person; may be "".
        public let name: String

        public init(sub: String = "", email: String = "", name: String = "") {
            self.sub = sub
            self.email = email
            self.name = name
        }

        private enum CodingKeys: String, CodingKey { case sub, email, name }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            sub = c.text(.sub, limit: 128)
            email = c.text(.email, limit: 320)
            name = c.text(.name, limit: 64).trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    /// Stable and unique in the list.
    public let id: String
    public let thing: String
    /// What the board ran before; nil when that is not known.
    public let from: String?
    /// What the update installs; nil for a job some other tool made.
    public let to: String?
    public let how: How
    /// The AWS IoT job, for a deployment.
    public let deployment: String?
    public let who: Who?
    public let outcome: Outcome
    public let startedAt: String?
    /// Nil while it is pending.
    public let endedAt: String?
    /// The AWS IoT execution status, for a deployment only.
    public let status: String?

    public init(id: String, thing: String, from: String? = nil, to: String? = nil, how: How, deployment: String? = nil,
                who: Who? = nil, outcome: Outcome, startedAt: String? = nil, endedAt: String? = nil, status: String? = nil) {
        self.id = id
        self.thing = thing
        self.from = from
        self.to = to
        self.how = how
        self.deployment = deployment
        self.who = who
        self.outcome = outcome
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.status = status
    }

    /// The time its row shows: when it ended, else when it started.
    public var time: String? { endedAt ?? startedAt }

    /// The deployment its row opens: one of this console's. Any other row opens the board.
    public var deploymentLink: String? {
        guard how == .deployment, let deployment, DeploymentId.isValid(deployment) else { return nil }
        return deployment
    }

    private enum CodingKeys: String, CodingKey { case id, thing, from, to, how, deployment, who, outcome, startedAt, endedAt, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = c.text(.id, limit: 200)
        let thing = c.text(.thing, limit: 64)
        guard !id.isEmpty, BoardName.isThing(thing) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not an update"))
        }
        self.id = id
        self.thing = thing
        from = c.version(.from)
        to = c.version(.to)
        how = How(rawValue: c.text(.how, limit: 24)) ?? .usbOrOther
        deployment = c.lenient(String.self, .deployment)
            .flatMap { $0.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil ? $0 : nil }
        who = c.lenient(Who.self, .who)
        outcome = Outcome(rawValue: c.text(.outcome, limit: 24)) ?? .pending
        startedAt = c.instant(.startedAt)
        endedAt = c.instant(.endedAt)
        status = c.lenient(String.self, .status)
            .flatMap { $0.range(of: "^[A-Z_]{1,24}$", options: .regularExpression) != nil ? $0 : nil }
    }
}

/// `GET /api/updates`: a page of updates, newest first, and the cursor of the next.
public struct UpdatesPage: Decodable, Equatable, Sendable {
    public let updates: [BoardUpdate]
    /// Nil: there are no more.
    public let cursor: String?
    public let generatedAt: String?

    public init(updates: [BoardUpdate], cursor: String? = nil, generatedAt: String? = nil) {
        self.updates = updates
        self.cursor = cursor
        self.generatedAt = generatedAt
    }

    private enum CodingKeys: String, CodingKey { case updates, cursor, generatedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var seen = Set<String>()
        // Each id once, as a list needs.
        updates = try c.decode(LenientList<BoardUpdate>.self, forKey: .updates).items.filter { seen.insert($0.id).inserted }
        cursor = c.lenient(String.self, .cursor).flatMap { Cursor.valid($0, limit: 2048) }
        generatedAt = c.instant(.generatedAt)
    }
}

/// How many boards of a deployment are in each state.
public struct Counts: Decodable, Equatable, Sendable {
    public var queued = 0
    public var inProgress = 0
    public var succeeded = 0
    public var failed = 0
    public var rejected = 0
    public var canceled = 0
    public var timedOut = 0
    public var removed = 0

    public init(queued: Int = 0, inProgress: Int = 0, succeeded: Int = 0, failed: Int = 0, rejected: Int = 0,
                canceled: Int = 0, timedOut: Int = 0, removed: Int = 0) {
        self.queued = queued
        self.inProgress = inProgress
        self.succeeded = succeeded
        self.failed = failed
        self.rejected = rejected
        self.canceled = canceled
        self.timedOut = timedOut
        self.removed = removed
    }

    private enum CodingKeys: String, CodingKey { case queued, inProgress, succeeded, failed, rejected, canceled, timedOut, removed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        queued = c.whole(.queued, 0, 1000) ?? 0
        inProgress = c.whole(.inProgress, 0, 1000) ?? 0
        succeeded = c.whole(.succeeded, 0, 1000) ?? 0
        failed = c.whole(.failed, 0, 1000) ?? 0
        rejected = c.whole(.rejected, 0, 1000) ?? 0
        canceled = c.whole(.canceled, 0, 1000) ?? 0
        timedOut = c.whole(.timedOut, 0, 1000) ?? 0
        removed = c.whole(.removed, 0, 1000) ?? 0
    }

    public var total: Int { queued + inProgress + succeeded + failed + rejected + canceled + timedOut + removed }

    /// Sums the counts of several deployments.
    public static func + (a: Counts, b: Counts) -> Counts {
        Counts(queued: a.queued + b.queued, inProgress: a.inProgress + b.inProgress, succeeded: a.succeeded + b.succeeded,
               failed: a.failed + b.failed, rejected: a.rejected + b.rejected, canceled: a.canceled + b.canceled,
               timedOut: a.timedOut + b.timedOut, removed: a.removed + b.removed)
    }

    func value(_ name: String) -> Int {
        switch name {
        case "queued": return queued
        case "inProgress": return inProgress
        case "succeeded": return succeeded
        case "failed": return failed
        case "rejected": return rejected
        case "canceled": return canceled
        case "timedOut": return timedOut
        case "removed": return removed
        default: return 0
        }
    }
}

/// One board's part in a deployment (`GET /api/deployments/{id}`).
public struct Execution: Decodable, Equatable, Sendable, Identifiable {
    public let thing: String
    /// QUEUED, IN_PROGRESS, SUCCEEDED, FAILED, REJECTED, CANCELED, TIMED_OUT, REMOVED
    public let status: String
    /// What the console makes of it with the board's own report (cloud/api/src/lib/timeline.mjs).
    public let phase: String
    public let progress: Int?
    public let reason: String?
    public let detail: String?
    /// What the job recorded the board ran when it finished the update.
    public let ranAtEnd: String?
    /// The board's latest word on what it runs, for an update it did not finish.
    public let reported: String?
    public let online: Bool
    public let queuedAt: String?
    public let startedAt: String?
    public let lastUpdatedAt: String?
    public let secondsLeft: Int?

    public var id: String { thing }

    public init(thing: String, status: String, phase: String, progress: Int? = nil, reason: String? = nil,
                detail: String? = nil, ranAtEnd: String? = nil, reported: String? = nil, online: Bool = false,
                queuedAt: String? = nil, startedAt: String? = nil, lastUpdatedAt: String? = nil, secondsLeft: Int? = nil) {
        self.thing = thing
        self.status = status
        self.phase = phase
        self.progress = progress
        self.reason = reason
        self.detail = detail
        self.ranAtEnd = ranAtEnd
        self.reported = reported
        self.online = online
        self.queuedAt = queuedAt
        self.startedAt = startedAt
        self.lastUpdatedAt = lastUpdatedAt
        self.secondsLeft = secondsLeft
    }

    private enum CodingKeys: String, CodingKey {
        case thing, status, phase, progress, reason, detail, ranAtEnd, reported, online, queuedAt, startedAt,
             lastUpdatedAt, secondsLeft
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        thing = c.text(.thing, limit: 64)
        status = c.text(.status, limit: 24)
        phase = c.text(.phase, limit: 32)
        progress = c.whole(.progress, 0, 100)
        let reason = c.boardText(.reason, limit: 48)
        self.reason = reason.isEmpty ? nil : reason
        let detail = c.boardText(.detail, limit: 96)
        self.detail = detail.isEmpty ? nil : detail
        ranAtEnd = c.version(.ranAtEnd)
        reported = c.version(.reported)
        online = c.bool(.online)
        queuedAt = c.instant(.queuedAt)
        startedAt = c.instant(.startedAt)
        lastUpdatedAt = c.instant(.lastUpdatedAt)
        secondsLeft = c.whole(.secondsLeft, 0, 10_000_000)
    }
}

/// A deployment: one release offered to a set of boards. The list (`GET /api/deployments`) has no
/// executions; one deployment's page (`GET /api/deployments/{id}`) has each board's.
public struct Deployment: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let version: String?
    /// IN_PROGRESS, COMPLETED, CANCELED, SCHEDULED, DELETION_IN_PROGRESS
    public let status: String
    public let createdAt: String?
    public let completedAt: String?
    public let createdBy: Person?
    public let note: String
    public let things: [String]
    public let counts: Counts
    public let executions: [Execution]

    public init(id: String, version: String?, status: String, createdAt: String? = nil, completedAt: String? = nil,
                createdBy: Person? = nil, note: String = "", things: [String] = [], counts: Counts = Counts(),
                executions: [Execution] = []) {
        self.id = id
        self.version = version
        self.status = status
        self.createdAt = createdAt
        self.completedAt = completedAt
        self.createdBy = createdBy
        self.note = note
        self.things = things
        self.counts = counts
        self.executions = executions
    }

    private enum CodingKeys: String, CodingKey {
        case id, version, status, createdAt, completedAt, createdBy, note, things, counts, executions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.text(.id, limit: 64)
        version = c.version(.version)
        status = c.text(.status, limit: 32)
        createdAt = c.instant(.createdAt)
        completedAt = c.instant(.completedAt)
        createdBy = c.lenient(Person.self, .createdBy)
        note = c.text(.note)
        things = c.texts(.things)
        counts = c.lenient(Counts.self, .counts) ?? Counts()
        executions = (c.lenient(LenientList<Execution>.self, .executions)?.items ?? []).filter { !$0.thing.isEmpty }
    }
}

/// One entry of the activity log (`GET /api/audit`).
public struct AuditEntry: Decodable, Equatable, Sendable, Identifiable {
    public struct Detail: Equatable, Sendable {
        public let key: String
        public let value: String

        public init(_ key: String, _ value: String) {
            self.key = key
            self.value = value
        }
    }

    public let at: String?
    public let actor: Person?
    /// firmware.upload, firmware.revoke, deployment.create, deployment.cancel, firmware.download,
    /// pairing.read, firmware.bluetooth_send, token.create, token.revoke
    public let action: String
    public let target: String
    /// ok, rejected, denied, error
    public let outcome: String
    public let detail: [Detail]
    public let requestId: String

    public var id: String { "\(at ?? "")-\(requestId)" }

    public init(at: String?, actor: Person?, action: String, target: String = "", outcome: String = "ok",
                detail: [Detail] = [], requestId: String = "") {
        self.at = at
        self.actor = actor
        self.action = action
        self.target = target
        self.outcome = outcome
        self.detail = detail
        self.requestId = requestId
    }

    private enum CodingKeys: String, CodingKey { case at, actor, action, target, outcome, detail, requestId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = c.instant(.at)
        actor = c.lenient(Person.self, .actor)
        action = c.text(.action, limit: 48)
        target = c.text(.target, limit: 96)
        outcome = c.text(.outcome, limit: 24)
        if let raw = c.lenient([String: LenientScalar].self, .detail) {
            detail = raw.compactMap { key, value in
                value.asText.map { Detail(String(key.prefix(24)), String($0.prefix(200))) }
            }
            .sorted { $0.key < $1.key }
            .prefix(8)
            .map { $0 }
        } else {
            detail = []
        }
        requestId = c.text(.requestId, limit: 64)
    }
}

/// A page of the activity log, newest first, and the cursor of the next.
public struct AuditPage: Decodable, Equatable, Sendable {
    public let entries: [AuditEntry]
    public let next: String?

    public init(entries: [AuditEntry], next: String? = nil) {
        self.entries = entries
        self.next = next
    }

    private enum CodingKeys: String, CodingKey { case entries, next }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entries = try c.decode(LenientList<AuditEntry>.self, forKey: .entries).items
        next = c.lenient(String.self, .next).flatMap(Cursor.valid)
    }
}

enum Cursor {
    static func valid(_ text: String) -> String? {
        valid(text, limit: 512)
    }

    static func valid(_ text: String, limit: Int) -> String? {
        text.range(of: "^[A-Za-z0-9_-]{1,\(limit)}$", options: .regularExpression) != nil ? text : nil
    }
}

/// What a board did, from the recorder (`GET /api/events`, cloud/api/src/lib/events.mjs).
public struct BoardEvent: Decodable, Equatable, Sendable, Identifiable {
    public static let kinds = ["connection", "firmware", "update", "restart", "bluetooth", "health"]

    public let thing: String
    public let at: String
    public let eventId: String
    /// connection, firmware, update, restart, bluetooth, health
    public let kind: String
    public let what: String
    /// info or warn
    public let level: String
    public let text: String
    public var version: String?
    public var from: String?
    public var to: String?
    public var confirmed: Bool?
    /// The deployment it is about, if any.
    public var job: String?
    public var state: String?
    public var progress: Int?
    public var result: String?
    public var error: String?
    public var upFor: Int?
    public var cause: String?
    public var stage: Int?
    public var boots: Int?
    public var newBoots: Int?
    public var count: Int?
    public var reason: String?
    public var proof: String?
    public var channel: Int?
    public var before: Int?
    public var heapLeast: Int?
    public var heapSize: Int?

    public var id: String { "\(thing.suffix(8))-\(at)-\(eventId)" }
    public var date: Date? { ConsoleTime.date(at) }

    public init(thing: String, at: String, id: String = "000000", kind: String, what: String = "", level: String = "info",
                text: String = "") {
        self.thing = thing
        self.at = at
        self.eventId = id
        self.kind = kind
        self.what = what
        self.level = level
        self.text = text
    }

    private enum CodingKeys: String, CodingKey {
        case thing, at, id, kind, what, level, text, version, from, to, confirmed, job, state, progress, result, error,
             upFor, cause, stage, boots, newBoots, count, reason, proof, channel, before, heapLeast, heapSize
    }

    static let updateStates: Set<String> = ["idle", "awaiting_user", "downloading", "verifying", "rebooting", "testing", "bluetooth"]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let thing = c.text(.thing, limit: 64)
        let kind = c.text(.kind, limit: 24)
        guard BoardName.isThing(thing), let at = c.instant(.at), Self.kinds.contains(kind) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not an event"))
        }
        self.thing = thing
        self.at = at
        let id = c.text(.id, limit: 6)
        eventId = id.range(of: "^[0-9a-f]{6}$", options: .regularExpression) != nil ? id : "000000"
        self.kind = kind
        what = c.boardText(.what, limit: 24)
        level = c.lenient(String.self, .level) == "warn" ? "warn" : "info"
        text = c.boardText(.text, limit: 200)
        let word = "^[a-z][a-z_]{0,31}$"
        func matching(_ key: CodingKeys, _ pattern: String) -> String? {
            guard let value = c.lenient(String.self, key), value.range(of: pattern, options: .regularExpression) != nil
            else { return nil }
            return value
        }
        version = c.version(.version)
        from = c.version(.from)
        to = c.version(.to)
        confirmed = c.lenient(Bool.self, .confirmed)
        job = c.lenient(String.self, .job).flatMap { DeploymentId.isValid($0) ? $0 : nil }
        state = c.lenient(String.self, .state).flatMap { Self.updateStates.contains($0) ? $0 : nil }
        progress = c.whole(.progress, 0, 100)
        result = matching(.result, word)
        let error = c.boardText(.error, limit: 64)
        self.error = error.isEmpty ? nil : error
        upFor = c.whole(.upFor, 0, 1 << 32)
        cause = matching(.cause, "^[0-9a-f]{1,8}$")
        stage = c.whole(.stage, 0, 255)
        boots = c.whole(.boots, 0, 1 << 32)
        newBoots = c.whole(.newBoots, 1, 1 << 32)
        count = c.whole(.count, 0, 1 << 32)
        reason = matching(.reason, "^[A-Za-z][A-Za-z_]{0,47}$")
        proof = matching(.proof, word)
        channel = c.whole(.channel, 1, 233)
        before = c.whole(.before, 1, 233)
        heapLeast = c.whole(.heapLeast, 0, 1 << 31)
        heapSize = c.whole(.heapSize, 1, 1 << 31)
    }
}

/// A page of events, newest first.
public struct EventPage: Decodable, Equatable, Sendable {
    public let events: [BoardEvent]
    public let cursor: String?
    public let from: String?
    public let to: String?

    public init(events: [BoardEvent], cursor: String? = nil, from: String? = nil, to: String? = nil) {
        self.events = events
        self.cursor = cursor
        self.from = from
        self.to = to
    }

    private enum CodingKeys: String, CodingKey { case events, cursor, from, to }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = try c.decode(LenientList<BoardEvent>.self, forKey: .events).items
        cursor = c.lenient(String.self, .cursor).flatMap(Cursor.valid)
        from = c.instant(.from)
        to = c.instant(.to)
    }
}

/// A board's readings over some hours (`GET /api/devices/{thing}/samples`), oldest first.
public struct Samples: Decodable, Equatable, Sendable {
    public struct Sample: Decodable, Equatable, Sendable {
        public let at: String
        public let rssi: Int?
        public let uptime: Int?
        public let heapFree: Int?
        public let heapLeast: Int?

        public init(at: String, rssi: Int? = nil, uptime: Int? = nil, heapFree: Int? = nil, heapLeast: Int? = nil) {
            self.at = at
            self.rssi = rssi
            self.uptime = uptime
            self.heapFree = heapFree
            self.heapLeast = heapLeast
        }

        private enum CodingKeys: String, CodingKey { case at, rssi, uptime, heapFree, heapLeast }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            guard let at = c.instant(.at) else {
                throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "no time"))
            }
            self.at = at
            rssi = c.whole(.rssi, -127, 0)
            uptime = c.whole(.uptime, 0, 1 << 32)
            heapFree = c.whole(.heapFree, 0, 1 << 31)
            heapLeast = c.whole(.heapLeast, 0, 1 << 31)
        }
    }

    public let samples: [Sample]
    public let hours: Int
    /// 0 when nothing was merged; else each sample stands for a bucket this long.
    public let bucketSeconds: Int
    public let from: String?
    public let to: String?

    public init(samples: [Sample], hours: Int = 24, bucketSeconds: Int = 0, from: String? = nil, to: String? = nil) {
        self.samples = samples
        self.hours = hours
        self.bucketSeconds = bucketSeconds
        self.from = from
        self.to = to
    }

    private enum CodingKeys: String, CodingKey { case samples, hours, bucketSeconds, from, to }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        samples = try c.decode(LenientList<Sample>.self, forKey: .samples).items
        hours = c.whole(.hours, 1, 168) ?? 24
        bucketSeconds = c.whole(.bucketSeconds, 0, 86_400) ?? 0
        from = c.instant(.from)
        to = c.instant(.to)
    }
}

/// One of a person's own API tokens. The list never holds the token itself.
public struct APIToken: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let createdAt: String?
    public let expiresAt: String?
    public let revokedAt: String?
    /// active, expired or revoked, by the server's clock.
    public let status: String

    public init(id: String, name: String, createdAt: String? = nil, expiresAt: String? = nil, revokedAt: String? = nil,
                status: String = "active") {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.revokedAt = revokedAt
        self.status = status
    }

    private enum CodingKeys: String, CodingKey { case id, name, createdAt, expiresAt, revokedAt, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = c.text(.id, limit: 16)
        self.id = TokenRules.isId(id) ? id : ""
        name = c.text(.name, limit: TokenRules.nameLimit)
        createdAt = c.instant(.createdAt)
        expiresAt = c.instant(.expiresAt)
        revokedAt = c.instant(.revokedAt)
        let status = c.lenient(String.self, .status) ?? ""
        // The server's word, for its own clock. Anything else is taken for the end of it.
        self.status = ["active", "expired", "revoked"].contains(status) ? status : "expired"
    }
}

/// `GET /api/tokens`.
public struct TokenList: Decodable, Equatable, Sendable {
    public let tokens: [APIToken]
    /// How many active tokens one person may have.
    public let limit: Int
    public let maxDays: Int

    public init(tokens: [APIToken], limit: Int = 10, maxDays: Int = 90) {
        self.tokens = tokens
        self.limit = limit
        self.maxDays = maxDays
    }

    private enum CodingKeys: String, CodingKey { case tokens, limit, maxDays }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tokens = try c.decode(LenientList<APIToken>.self, forKey: .tokens).items.filter { !$0.id.isEmpty }
        limit = c.whole(.limit, 1, 1000) ?? 10
        maxDays = c.whole(.maxDays, 1, 3650) ?? TokenRules.mostDays
    }

    public var active: Int { tokens.filter { $0.status == "active" }.count }
}

/// The answer to making a token: the token itself, shown once.
public struct NewToken: Decodable, Equatable, Sendable {
    public let token: String
    public let id: String
    public let name: String
    public let createdAt: String?
    public let expiresAt: String?

    public init(token: String, id: String, name: String, createdAt: String? = nil, expiresAt: String? = nil) {
        self.token = token
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey { case token, id, name, createdAt, expiresAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let token = c.text(.token, limit: 64)
        let id = c.text(.id, limit: 16)
        guard token.range(of: "^crn_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil, TokenRules.isId(id) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not a token"))
        }
        self.token = token
        self.id = id
        name = c.text(.name, limit: TokenRules.nameLimit)
        createdAt = c.instant(.createdAt)
        expiresAt = c.instant(.expiresAt)
    }
}

/// What the console allows for an API token (cloud/api/src/lib/tokens.mjs).
public enum TokenRules {
    public static let nameLimit = 40
    public static let leastDays = 1
    public static let mostDays = 90
    public static let usualDays = 30

    public static func isId(_ text: String) -> Bool {
        text.range(of: "^[0-9a-f]{16}$", options: .regularExpression) != nil
    }

    /// The number of days typed in a field, if the server takes it: a whole number from 1 to 90.
    public static func days(_ text: String) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard trimmed.range(of: "^[0-9]{1,3}$", options: .regularExpression) != nil, let days = Int(trimmed),
              (leastDays...mostDays).contains(days) else { return nil }
        return days
    }
}

/// A deployment's id: `cranium-1-8-0-b0-20261102T143000Z-1a2b`, which names its version.
public enum DeploymentId {
    public static func isValid(_ text: String) -> Bool {
        text.range(of: #"^cranium-\d{1,3}-\d{1,3}-\d{1,5}-b\d{1,10}-\d{8}T\d{6}Z-[0-9a-f]{4}$"#,
                   options: .regularExpression) != nil
    }

    /// The version the deployment installs, recovered from its id.
    public static func version(of id: String?) -> String? {
        guard let id, isValid(id) else { return nil }
        let parts = id.split(separator: "-")
        guard parts.count >= 5, parts[4].hasPrefix("b"),
              let major = Int(parts[1]), let minor = Int(parts[2]), let revision = Int(parts[3]),
              let build = Int(parts[4].dropFirst()) else { return nil }
        let version = "\(major).\(minor).\(revision)+\(build)"
        return Lenient.isVersion(version) ? version : nil
    }
}
