import Foundation
import HealthKit

/// Health data for the agent, read only (backend BACKEND 7.13b): totals and averages over a date range for steps, active energy,
/// workouts, sleep and body weight. Never raw samples, never a write (the share set of the permission request is empty).
/// HealthKit does not tell an app which types the owner refused (a refused type just has no data), so the access is `.asked` once
/// the system sheet has been shown, and "no data" is reported as possibly not allowed.
@MainActor struct HealthSystem: PhoneSystem {
    private static let askedKey = "phone.health.asked"
    private let service = HealthService()

    var access: PhoneAccess {
        guard HKHealthStore.isHealthDataAvailable() else { return .unavailable }
        return UserDefaults.standard.bool(forKey: Self.askedKey) ? .asked : .notAsked
    }

    func request() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        await service.request()
        UserDefaults.standard.set(true, forKey: Self.askedKey)
    }

    func actions(for access: PhoneAccess) -> [String] { access.usable ? ["health.read"] : [] }
    func changes(_ action: String) -> Bool { false }

    func run(_ action: String, _ args: [String: JSONValue]) async throws -> JSONValue {
        guard action == "health.query" else { throw PhoneCallError("This version of Juno on the iPhone does not know \(action).") }
        guard HKHealthStore.isHealthDataAvailable() else { throw PhoneCallError("Health data isn't available on this iPhone.") }
        return try await service.query(args)
    }
}

actor HealthService {
    private let store = HKHealthStore()
    private static let maxDays = 92

    private var readTypes: Set<HKObjectType> {
        [HKQuantityType(.stepCount), HKQuantityType(.activeEnergyBurned), HKQuantityType(.bodyMass), HKCategoryType(.sleepAnalysis), HKObjectType.workoutType()]
    }

    func request() async {
        try? await store.requestAuthorization(toShare: [], read: readTypes)
    }

    func query(_ args: [String: JSONValue]) async throws -> JSONValue {
        let metric = try args.requiredString("metric")
        let (start, end) = try Self.range(args)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        do {
            switch metric {
            case "steps": return try await daily(HKQuantityType(.stepCount), unit: .count(), name: "steps", start: start, end: end, predicate: predicate)
            case "active_energy": return try await daily(HKQuantityType(.activeEnergyBurned), unit: .kilocalorie(), name: "kilocalories", start: start, end: end, predicate: predicate)
            case "body_mass": return try await bodyMass(predicate)
            case "sleep": return try await sleep(predicate)
            case "workouts": return try await workouts(predicate)
            default: throw PhoneCallError("`metric` must be steps, active_energy, workouts, sleep or body_mass.")
            }
        } catch let error as HKError where error.code == .errorDatabaseInaccessible {
            throw PhoneCallError("Health data is locked while the iPhone is locked. Ask the owner to unlock it and try again.")
        }
    }

    // MARK: Range

    /// A date means the whole day (`to` the end of it); a time is taken as given. At most 92 days.
    private static func range(_ args: [String: JSONValue]) throws -> (Date, Date) {
        let from = try PhoneTime.date(args, "from")
        let to = try PhoneTime.end(args, "to")
        guard to > from else { throw PhoneCallError("`to` must be after `from`.") }
        guard to.timeIntervalSince(from) <= Double(maxDays) * 86_400 else { throw PhoneCallError("Ask for at most \(maxDays) days at a time.") }
        return (from, to)
    }

    private static func day(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private static let noData = "No data in this range. It may also mean the owner did not allow Juno to read this in the Health app (iOS does not say)."

    // MARK: Steps and active energy

    private func daily(_ type: HKQuantityType, unit: HKUnit, name: String, start: Date, end: Date, predicate: NSPredicate) async throws -> JSONValue {
        let descriptor = HKStatisticsCollectionQueryDescriptor(
            predicate: .quantitySample(type: type, predicate: predicate), options: .cumulativeSum,
            anchorDate: Calendar.current.startOfDay(for: start), intervalComponents: DateComponents(day: 1))
        let collection = try await descriptor.result(for: store)
        var days: [(date: Date, value: Double)] = []
        collection.enumerateStatistics(from: start, to: end) { statistics, _ in
            if let sum = statistics.sumQuantity() { days.append((statistics.startDate, sum.doubleValue(for: unit))) }
        }
        let withData = days.filter { $0.value > 0 }
        guard !withData.isEmpty else { return .object(["unit": .string(name), "note": .string(Self.noData)]) }
        let total = withData.reduce(0) { $0 + $1.value }
        let spanDays = max(1, Int((end.timeIntervalSince(start) / 86_400).rounded(.up)))
        var out: [String: JSONValue] = [
            "unit": .string(name), "total": .number(total.rounded()), "daysWithData": .number(Double(withData.count)),
            "averagePerDay": .number((total / Double(spanDays)).rounded()),
            "highest": Self.dayValue(withData.max { $0.value < $1.value }), "lowest": Self.dayValue(withData.min { $0.value < $1.value }),
        ]
        if spanDays <= 31 { out["perDay"] = .array(days.map { .object(["date": .string(Self.day($0.date)), "value": .number($0.value.rounded())]) }) }
        return .object(out)
    }

    private static func dayValue(_ day: (date: Date, value: Double)?) -> JSONValue {
        guard let day else { return .null }
        return .object(["date": .string(Self.day(day.date)), "value": .number(day.value.rounded())])
    }

    // MARK: Body weight

    private func bodyMass(_ predicate: NSPredicate) async throws -> JSONValue {
        let type = HKQuantityType(.bodyMass)
        let descriptor = HKSampleQueryDescriptor(predicates: [.quantitySample(type: type, predicate: predicate)], sortDescriptors: [SortDescriptor(\.startDate)], limit: 500)
        let samples = try await descriptor.result(for: store)
        guard let first = samples.first, let last = samples.last else { return .object(["unit": .string("kg"), "note": .string(Self.noData)]) }
        let kilograms = samples.map { $0.quantity.doubleValue(for: .gramUnit(with: .kilo)) }
        let firstKg = kilograms[0], lastKg = kilograms[kilograms.count - 1]
        func round1(_ value: Double) -> JSONValue { .number((value * 10).rounded() / 10) }
        return .object([
            "unit": .string("kg"), "readings": .number(Double(samples.count)),
            "first": .object(["date": .string(Self.day(first.startDate)), "value": round1(firstKg)]),
            "last": .object(["date": .string(Self.day(last.startDate)), "value": round1(lastKg)]),
            "change": round1(lastKg - firstKg), "lowest": round1(kilograms.min() ?? firstKg), "highest": round1(kilograms.max() ?? firstKg),
        ])
    }

    // MARK: Sleep

    /// Per night (the day the sleep ended): time asleep with overlapping samples counted once, and the stages when the watch gave them.
    private func sleep(_ predicate: NSPredicate) async throws -> JSONValue {
        let descriptor = HKSampleQueryDescriptor(predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: predicate)], sortDescriptors: [SortDescriptor(\.startDate)], limit: 5000)
        let samples = try await descriptor.result(for: store)
        var nights: [String: (asleep: [(Date, Date)], core: Double, deep: Double, rem: Double, awake: Double)] = [:]
        for sample in samples {
            guard let value = HKCategoryValueSleepAnalysis(rawValue: sample.value) else { continue }
            let key = Self.day(sample.endDate)
            var night = nights[key] ?? ([], 0, 0, 0, 0)
            let minutes = sample.endDate.timeIntervalSince(sample.startDate) / 60
            if HKCategoryValueSleepAnalysis.allAsleepValues.contains(value) { night.asleep.append((sample.startDate, sample.endDate)) }
            switch value {
            case .asleepCore: night.core += minutes
            case .asleepDeep: night.deep += minutes
            case .asleepREM: night.rem += minutes
            case .awake: night.awake += minutes
            default: break
            }
            nights[key] = night
        }
        let rows = nights.map { key, night -> (String, Double, JSONValue) in
            let hours = (Self.unionMinutes(night.asleep) / 6).rounded() / 10
            var row: [String: JSONValue] = ["night": .string(key), "hoursAsleep": .number(hours)]
            if night.deep + night.rem + night.core > 0 {
                row["coreMinutes"] = .number(night.core.rounded()); row["deepMinutes"] = .number(night.deep.rounded()); row["remMinutes"] = .number(night.rem.rounded())
                row["awakeMinutes"] = .number(night.awake.rounded())
            }
            return (key, hours, .object(row))
        }.filter { $0.1 > 0 }.sorted { $0.0 < $1.0 }
        guard !rows.isEmpty else { return .object(["note": .string(Self.noData)]) }
        let average = rows.reduce(0) { $0 + $1.1 } / Double(rows.count)
        var out: [String: JSONValue] = ["nights": .number(Double(rows.count)), "averageHoursAsleep": .number((average * 10).rounded() / 10)]
        out["perNight"] = .array(rows.suffix(31).map(\.2))
        return .object(out)
    }

    /// Minutes covered by the intervals, overlaps counted once (two sources can record the same night).
    private static func unionMinutes(_ intervals: [(Date, Date)]) -> Double {
        var total = 0.0
        var current: (Date, Date)?
        for interval in intervals.sorted(by: { $0.0 < $1.0 }) {
            if let open = current, interval.0 <= open.1 { current = (open.0, max(open.1, interval.1)) }
            else {
                if let open = current { total += open.1.timeIntervalSince(open.0) / 60 }
                current = interval
            }
        }
        if let open = current { total += open.1.timeIntervalSince(open.0) / 60 }
        return total
    }

    // MARK: Workouts

    private func workouts(_ predicate: NSPredicate) async throws -> JSONValue {
        let descriptor = HKSampleQueryDescriptor(predicates: [.workout(predicate)], sortDescriptors: [SortDescriptor(\.startDate, order: .reverse)], limit: 200)
        let found = try await descriptor.result(for: store)
        guard !found.isEmpty else { return .object(["note": .string(Self.noData)]) }
        let energy = HKQuantityType(.activeEnergyBurned)
        let rows: [JSONValue] = found.prefix(20).map { workout in
            var row: [String: JSONValue] = [
                "type": .string(Self.name(workout.workoutActivityType)), "start": .string(PhoneTime.iso(workout.startDate)),
                "minutes": .number((workout.duration / 60).rounded()),
            ]
            if let kcal = workout.statistics(for: energy)?.sumQuantity()?.doubleValue(for: .kilocalorie()) { row["kilocalories"] = .number(kcal.rounded()) }
            return .object(row)
        }
        var byType: [String: Int] = [:]
        for workout in found { byType[Self.name(workout.workoutActivityType), default: 0] += 1 }
        return .object([
            "count": .number(Double(found.count)), "totalMinutes": .number((found.reduce(0) { $0 + $1.duration } / 60).rounded()),
            "byType": .object(byType.mapValues { .number(Double($0)) }), "latest": .array(rows),
        ])
    }

    private static func name(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: "running"
        case .walking: "walking"
        case .cycling: "cycling"
        case .swimming: "swimming"
        case .hiking: "hiking"
        case .yoga: "yoga"
        case .functionalStrengthTraining, .traditionalStrengthTraining: "strength training"
        case .highIntensityIntervalTraining: "HIIT"
        case .elliptical: "elliptical"
        case .rowing: "rowing"
        case .dance: "dance"
        default: "other"
        }
    }
}
