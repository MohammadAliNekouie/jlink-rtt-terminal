package expo.modules.jlinkusb

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Thin USB bulk transport for a SEGGER J-Link. All protocol logic lives in TypeScript.
 * Data crosses the bridge as base64 strings.
 */
class JLinkUsbModule : Module() {

    companion object {
        private const val SEGGER_VID = 0x1366
        private const val ACTION_PERM = "expo.modules.jlinkusb.USB_PERMISSION"
        private const val CHUNK = 2048
        private const val TIMEOUT_MS = 1000
    }

    private var conn: UsbDeviceConnection? = null
    private var iface: UsbInterface? = null
    private var epIn: UsbEndpoint? = null
    private var epOut: UsbEndpoint? = null
    private var devName: String? = null
    private var desc: String = ""
    private val rx = ByteArray(CHUNK)
    private var rxPos = 0
    private var rxLen = 0

    private fun context(): Context =
        appContext.reactContext ?: throw IllegalStateException("No Android context")

    private fun manager(): UsbManager = context().getSystemService(Context.USB_SERVICE) as UsbManager

    private fun findDevice(name: String): UsbDevice =
        manager().deviceList.values.firstOrNull { it.deviceName == name && it.vendorId == SEGGER_VID }
            ?: throw IllegalStateException("J-Link device $name not found")

    private fun hex(v: Int): String = "0x" + Integer.toHexString(v)

    /** Is the probe still enumerated? (false after a probe reset, unplug or USB power dip) */
    private fun present(): Boolean {
        val n = devName ?: return false
        return try {
            manager().deviceList.containsKey(n)
        } catch (_: Exception) {
            false
        }
    }

    private fun presence(): String =
        if (present()) "probe still on USB bus" else "probe GONE from USB bus (reset, unplugged or USB power dip)"

    private fun describeDevice(dev: UsbDevice): String {
        val sb = StringBuilder()
        sb.append("VID:PID ").append(hex(dev.vendorId)).append(":").append(hex(dev.productId))
        for (i in 0 until dev.interfaceCount) {
            val itf = dev.getInterface(i)
            sb.append(" | if").append(itf.id)
                .append(" class ").append(hex(itf.interfaceClass))
                .append("/").append(hex(itf.interfaceSubclass))
                .append("/").append(hex(itf.interfaceProtocol))
            for (k in 0 until itf.endpointCount) {
                val ep = itf.getEndpoint(k)
                val kind = if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK) "bulk" else "type" + ep.type
                sb.append(" [").append(hex(ep.address)).append(" ").append(kind).append(" ")
                    .append(ep.maxPacketSize).append("]")
            }
        }
        return sb.toString()
    }

    private fun hasBulkPair(itf: UsbInterface): Boolean {
        var hasIn = false
        var hasOut = false
        for (k in 0 until itf.endpointCount) {
            val ep = itf.getEndpoint(k)
            if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
            if (ep.direction == UsbConstants.USB_DIR_IN) hasIn = true else hasOut = true
        }
        return hasIn && hasOut
    }

    /** First vendor-specific interface with a bulk IN+OUT pair (prefers subclass 0xFF, but OB firmwares differ). */
    private fun pickInterface(dev: UsbDevice): UsbInterface? {
        for (pass in 0..1) {
            for (i in 0 until dev.interfaceCount) {
                val itf = dev.getInterface(i)
                if (itf.interfaceClass != UsbConstants.USB_CLASS_VENDOR_SPEC) continue
                if (pass == 0 && itf.interfaceSubclass != UsbConstants.USB_CLASS_VENDOR_SPEC) continue
                if (hasBulkPair(itf)) return itf
            }
        }
        return null
    }

    /** Clear a stalled/halted endpoint (standard CLEAR_FEATURE ENDPOINT_HALT). */
    private fun clearHalt(c: UsbDeviceConnection, ep: UsbEndpoint) {
        try {
            c.controlTransfer(0x02, 0x01, 0, ep.address, null, 0, 500)
        } catch (_: Exception) {
        }
    }

    /** USB GET_STATUS(endpoint): "halted" / "ok" / "?" - tells a STALL from a plain timeout. */
    private fun epState(c: UsbDeviceConnection, ep: UsbEndpoint): String {
        return try {
            val b = ByteArray(2)
            val r = c.controlTransfer(0x82, 0x00, 0, ep.address, b, 2, 300)
            if (r == 2) (if ((b[0].toInt() and 1) != 0) "halted" else "ok") else "?"
        } catch (_: Exception) {
            "?"
        }
    }

    override fun definition() = ModuleDefinition {
        Name("JLinkUsb")

        Function("listDevices") {
            manager().deviceList.values
                .filter { it.vendorId == SEGGER_VID }
                .map { mapOf("name" to it.deviceName, "vid" to it.vendorId, "pid" to it.productId) }
        }

        AsyncFunction("requestPermission") { name: String, promise: Promise ->
            val ctx = context()
            val mgr = manager()
            val dev = findDevice(name)
            if (mgr.hasPermission(dev)) {
                promise.resolve(true)
                return@AsyncFunction
            }
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) {
                    try {
                        ctx.unregisterReceiver(this)
                    } catch (_: Exception) {
                    }
                    promise.resolve(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
                }
            }
            val filter = IntentFilter(ACTION_PERM)
            if (Build.VERSION.SDK_INT >= 33) {
                ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                ctx.registerReceiver(receiver, filter)
            }
            val intent = Intent(ACTION_PERM).setPackage(ctx.packageName)
            val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
            mgr.requestPermission(dev, PendingIntent.getBroadcast(ctx, 0, intent, flags))
        }

        AsyncFunction("open") { name: String ->
            closeInternal()
            val dev = findDevice(name)
            val itf = pickInterface(dev)
                ?: throw IllegalStateException("No J-Link vendor interface. Descriptors: " + describeDevice(dev))
            var inEp: UsbEndpoint? = null
            var outEp: UsbEndpoint? = null
            for (i in 0 until itf.endpointCount) {
                val ep = itf.getEndpoint(i)
                if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
                if (ep.direction == UsbConstants.USB_DIR_IN) {
                    if (inEp == null) inEp = ep
                } else {
                    if (outEp == null) outEp = ep
                }
            }
            if (inEp == null || outEp == null) throw IllegalStateException("Bulk endpoints not found")
            val c = manager().openDevice(dev) ?: throw IllegalStateException("openDevice failed (no permission?)")
            if (!c.claimInterface(itf, true)) {
                c.close()
                throw IllegalStateException("claimInterface failed. Descriptors: " + describeDevice(dev))
            }
            conn = c
            iface = itf
            epIn = inEp
            epOut = outEp
            devName = name
            desc = describeDevice(dev) + " | using if" + itf.id + " in=" + hex(inEp.address) + " out=" + hex(outEp.address)
            rxPos = 0
            rxLen = 0
            true
        }

        // Write [b64] to the OUT endpoint (may be empty), then read exactly [expect] bytes from IN.
        AsyncFunction("transact") { b64: String, expect: Int ->
            val c = conn ?: throw IllegalStateException("Not open")
            val eo = epOut ?: throw IllegalStateException("Not open")
            val ei = epIn ?: throw IllegalStateException("Not open")
            val data = if (b64.isEmpty()) ByteArray(0) else Base64.decode(b64, Base64.NO_WRAP)

            var off = 0
            var fails = 0
            while (off < data.size) {
                val t0 = System.nanoTime()
                val n = c.bulkTransfer(eo, data, off, minOf(CHUNK, data.size - off), TIMEOUT_MS)
                if (n < 0) {
                    val ms = (System.nanoTime() - t0) / 1000000L
                    fails++
                    if (fails >= 3) {
                        rxPos = 0
                        rxLen = 0
                        throw IllegalStateException(
                            "USB write failed (ep " + hex(eo.address) + ", " + off + "/" + data.size +
                                " bytes sent, result " + n + " after " + ms + " ms, endpoint " + epState(c, eo) +
                                ", " + presence() + ")"
                        )
                    }
                    clearHalt(c, eo)
                    try {
                        val i = iface
                        if (i != null) c.setInterface(i)
                    } catch (_: Exception) {
                    }
                    continue
                }
                fails = 0
                off += n
            }

            val out = ByteArray(expect)
            var o = 0
            while (o < expect) {
                if (rxLen - rxPos == 0) {
                    var n = -1
                    var attempts = 5
                    while (attempts-- > 0 && n <= 0) {
                        n = c.bulkTransfer(ei, rx, 0, CHUNK, TIMEOUT_MS)
                        if (n <= 0 && attempts == 2) clearHalt(c, ei)
                    }
                    if (n <= 0) {
                        rxPos = 0
                        rxLen = 0
                        throw IllegalStateException(
                            "USB read timeout (ep " + hex(ei.address) + ", " + o + "/" + expect +
                                " bytes received, " + presence() + ")"
                        )
                    }
                    rxPos = 0
                    rxLen = n
                }
                val take = minOf(expect - o, rxLen - rxPos)
                System.arraycopy(rx, rxPos, out, o, take)
                rxPos += take
                o += take
            }
            if (expect == 0) "" else Base64.encodeToString(out, Base64.NO_WRAP)
        }

        // Drain any stale response bytes the probe is still trying to send (a blocked probe stops reading commands).
        Function("flush") {
            val c = conn
            val ei = epIn
            var total = 0
            if (c != null && ei != null) {
                for (k in 0 until 40) {
                    val n = c.bulkTransfer(ei, rx, 0, CHUNK, 60)
                    if (n <= 0) break
                    total += n
                }
            }
            rxPos = 0
            rxLen = 0
            total
        }

        Function("describe") {
            desc
        }

        Function("close") {
            closeInternal()
        }

        OnDestroy {
            closeInternal()
        }
    }

    private fun closeInternal() {
        try {
            val c = conn
            val i = iface
            if (c != null && i != null) c.releaseInterface(i)
            c?.close()
        } catch (_: Exception) {
        }
        conn = null
        iface = null
        epIn = null
        epOut = null
        devName = null
        rxPos = 0
        rxLen = 0
    }
}
