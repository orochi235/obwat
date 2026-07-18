import Foundation
import IOBluetooth

final class Printer: NSObject, IOBluetoothRFCOMMChannelDelegate {
    var statuses: [Data] = []
    var buffer = Data()

    func rfcommChannelData(_ channel: IOBluetoothRFCOMMChannel!, data: UnsafeMutableRawPointer!, length: Int) {
        buffer.append(Data(bytes: data, count: length))
        while buffer.count >= 32 {
            let status = [UInt8](buffer.prefix(32)) // copy to 0-based array; Data slices keep parent indices
            buffer.removeFirst(32)
            statuses.append(Data(status))
            // status type: 0=reply, 1=printing done, 2=error, 6=phase change
            print("STATUS type=\(status[18]) err=(\(status[8]),\(status[9])) phase=(\(status[19]),\(status[20]),\(status[21]))")
        }
    }

    func rfcommChannelClosed(_ channel: IOBluetoothRFCOMMChannel!) {
        print("channel closed by remote")
    }
}

let jobURL = URL(fileURLWithPath: CommandLine.arguments[1])
var job = try Data(contentsOf: jobURL)
print("job size: \(job.count) bytes")

guard let dev = IOBluetoothDevice(addressString: "EC:79:49:64:1F:B8") else { exit(1) }
let printer = Printer()
var channel: IOBluetoothRFCOMMChannel?
let res = dev.openRFCOMMChannelSync(&channel, withChannelID: 1, delegate: printer)
print("openRFCOMMChannelSync: \(res)")
guard res == kIOReturnSuccess, let ch = channel else { exit(2) }

let mtu = Int(ch.getMTU())
print("MTU: \(mtu)")
var offset = 0
while offset < job.count {
    let end = min(offset + mtu, job.count)
    var chunk = job.subdata(in: offset..<end)
    let len = UInt16(chunk.count)
    let wr = chunk.withUnsafeMutableBytes { buf in
        ch.writeSync(buf.baseAddress, length: len)
    }
    if wr != kIOReturnSuccess { print("writeSync failed at \(offset): \(wr)"); exit(3) }
    offset = end
}
print("job fully written, waiting for status flow...")
RunLoop.current.run(until: Date().addingTimeInterval(25))
print("FINAL: \(printer.statuses.count) status packets")
ch.close()
dev.closeConnection()
