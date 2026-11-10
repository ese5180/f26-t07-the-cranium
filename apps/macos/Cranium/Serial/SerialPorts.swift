import Foundation
import IOKit
import IOKit.serial

/// One USB serial port on this Mac (`/dev/cu.*`), as the I/O Registry describes it.
struct SerialPortInfo: Equatable {
    /// SEGGER, the maker of the J-Link on the nRF DKs; the page's own filter (setup.js SEGGER_VENDOR_ID).
    static let seggerVendorID = 0x1366

    let path: String
    let vendorID: Int?
    let productID: Int?
    let product: String?
    let serialNumber: String?
    let locationID: Int?

    /// The same USB device for all of its ports (a J-Link has two): vendor, product and serial number, or
    /// where it is plugged in when it has no serial number.
    var deviceKey: String {
        let id = String(format: "%04x:%04x", vendorID ?? 0, productID ?? 0)
        if let serialNumber, !serialNumber.isEmpty { return "\(id):\(serialNumber)" }
        return "\(id)@\(locationID.map { String($0, radix: 16) } ?? path)"
    }

    /// A callout device's registry properties as a port; nil for anything that is not `/dev/cu.*`.
    init?(properties: [String: Any]) {
        guard let path = properties[kIOCalloutDeviceKey] as? String, path.hasPrefix("/dev/cu."), path.count < 256 else { return nil }
        func number(_ key: String) -> Int? { (properties[key] as? NSNumber)?.intValue }
        func text(_ key: String) -> String? {
            guard let value = properties[key] as? String else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : String(trimmed.prefix(80))
        }
        self.path = path
        vendorID = number("idVendor")
        productID = number("idProduct")
        product = text("USB Product Name")
        serialNumber = text("USB Serial Number")
        locationID = number("locationID")
    }

    init(path: String, vendorID: Int?, productID: Int? = nil, product: String? = nil, serialNumber: String? = nil, locationID: Int? = nil) {
        self.path = path
        self.vendorID = vendorID
        self.productID = productID
        self.product = product
        self.serialNumber = serialNumber
        self.locationID = locationID
    }
}

/// A USB device with serial ports, as the picker lists it: by product name and serial number.
struct SerialBoard: Equatable {
    /// A port index (usb.open's `port`) is at most 7 (apps/shared/bridge.json).
    static let maxPorts = 8

    let key: String
    let title: String
    /// Sorted by path, so index 0 is the first and the last is the console (VCOM1 of a J-Link), which is
    /// opened first, as on Android.
    let ports: [SerialPortInfo]

    /// The USB serial devices among `ports`, grouped by device: SEGGER first, then by name.
    static func group(_ ports: [SerialPortInfo]) -> [SerialBoard] {
        let usb = ports.filter { $0.vendorID != nil }
        let groups = Dictionary(grouping: usb, by: \.deviceKey)
        return groups.map { key, members in
            let sorted = members.sorted { $0.path < $1.path }
            let first = sorted[0]
            var title = first.product ?? "USB serial device"
            if let serial = first.serialNumber { title += " (\(serial))" }
            return SerialBoard(key: key, title: title, ports: Array(sorted.prefix(maxPorts)))
        }
        .sorted { left, right in
            let leftSegger = left.ports[0].vendorID == SerialPortInfo.seggerVendorID
            let rightSegger = right.ports[0].vendorID == SerialPortInfo.seggerVendorID
            if leftSegger != rightSegger { return leftSegger }
            return (left.title, left.key) < (right.title, right.key)
        }
    }
}

/// Where the Mac's serial ports come from; a fake in the tests.
protocol SerialPortLister {
    func list() -> [SerialPortInfo]
}

/// The I/O Registry's serial ports (`IOSerialBSDClient`), each with what its USB parents say of it.
struct IOKitSerialLister: SerialPortLister {
    func list() -> [SerialPortInfo] {
        guard let matching = IOServiceMatching(kIOSerialBSDServiceValue) as NSMutableDictionary? else { return [] }
        matching[kIOSerialBSDTypeKey] = kIOSerialBSDAllTypes
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator) == KERN_SUCCESS else { return [] }
        defer { IOObjectRelease(iterator) }
        var found: [SerialPortInfo] = []
        var service = IOIteratorNext(iterator)
        while service != 0 {
            var properties = Self.properties(of: service) ?? [:]
            for key in ["idVendor", "idProduct", "USB Product Name", "USB Serial Number", "locationID"] {
                let value = IORegistryEntrySearchCFProperty(service, kIOServicePlane, key as CFString, kCFAllocatorDefault,
                                                            IOOptionBits(kIORegistryIterateRecursively | kIORegistryIterateParents))
                if let value { properties[key] = value }
            }
            if let port = SerialPortInfo(properties: properties) { found.append(port) }
            IOObjectRelease(service)
            service = IOIteratorNext(iterator)
        }
        return found
    }

    private static func properties(of service: io_registry_entry_t) -> [String: Any]? {
        var unmanaged: Unmanaged<CFMutableDictionary>?
        guard IORegistryEntryCreateCFProperties(service, &unmanaged, kCFAllocatorDefault, 0) == KERN_SUCCESS,
              let dictionary = unmanaged?.takeRetainedValue() else { return nil }
        return dictionary as? [String: Any]
    }
}
