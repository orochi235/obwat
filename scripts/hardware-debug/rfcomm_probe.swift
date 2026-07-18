import Foundation
import IOBluetooth

final class Probe: NSObject, IOBluetoothRFCOMMChannelDelegate {
    var received = Data()

    func rfcommChannelData(_ channel: IOBluetoothRFCOMMChannel!, data: UnsafeMutableRawPointer!, length: Int) {
        received.append(Data(bytes: data, count: length))
        print("RX \(length) bytes: \(received.map { String(format: "%02x", $0) }.joined(separator: " "))")
    }

    func rfcommChannelOpenComplete(_ channel: IOBluetoothRFCOMMChannel!, status error: IOReturn) {
        print("openComplete status: \(error)")
    }

    func rfcommChannelClosed(_ channel: IOBluetoothRFCOMMChannel!) {
        print("channel closed by remote")
    }
}

guard let dev = IOBluetoothDevice(addressString: "EC:79:49:64:1F:B8") else {
    print("no device"); exit(1)
}

print("SDP query...")
let sdpResult = dev.performSDPQuery(nil)
print("performSDPQuery returned: \(sdpResult)")
Thread.sleep(forTimeInterval: 3)

var channelID: BluetoothRFCOMMChannelID = 1
if let spp = dev.getServiceRecord(for: IOBluetoothSDPUUID(uuid16: 0x1101)) {
    var cid: BluetoothRFCOMMChannelID = 0
    if spp.getRFCOMMChannelID(&cid) == kIOReturnSuccess {
        channelID = cid
        print("SPP service found, RFCOMM channel \(cid)")
    } else {
        print("SPP record found but no channel id; using 1")
    }
} else {
    print("no SPP service record; using channel 1")
}

let probe = Probe()
var channel: IOBluetoothRFCOMMChannel?
print("opening RFCOMM channel \(channelID) sync...")
let res = dev.openRFCOMMChannelSync(&channel, withChannelID: channelID, delegate: probe)
print("openRFCOMMChannelSync: \(res) (0 = success; -536870212/0x8000404c often = auth/page fail)")

if res == kIOReturnSuccess, let ch = channel {
    var payload = Data(count: 100)                    // invalidate
    payload.append(contentsOf: [0x1b, 0x40])          // init
    payload.append(contentsOf: [0x1b, 0x69, 0x53])    // status request
    let count = UInt16(payload.count)
    let wr = payload.withUnsafeMutableBytes { buf in
        ch.writeSync(buf.baseAddress, length: count)
    }
    print("writeSync: \(wr)")
    RunLoop.current.run(until: Date().addingTimeInterval(6))
    print("FINAL: \(probe.received.count) bytes")
    ch.close()
}
dev.closeConnection()
