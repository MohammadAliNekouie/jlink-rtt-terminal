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
    private val rx = ByteArray(CHUNK)
    private var rxPos = 0
    private var rxLen = 0

    private fun context(): Context =
        appContext.reactContext ?: throw IllegalStateException("No Android context")

    private fun manager(): UsbManager = context().getSystemService(Context.USB_SERVICE) as UsbManager

    private fun findDevice(name: String): UsbDevice =
        manager().deviceList.values.firstOrNull { it.deviceName == name && it.vendorId == SEGGER_VID }
            ?: throw IllegalStateException("J-Link device $name not found")

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
            var found: UsbInterface? = null
            for (i in 0 until dev.interfaceCount) {
                val itf = dev.getInterface(i)
                if (itf.interfaceClass == UsbConstants.USB_CLASS_VENDOR_SPEC &&
                    itf.interfaceSubclass == UsbConstants.USB_CLASS_VENDOR_SPEC &&
                    itf.endpointCount >= 2
                ) {
                    found = itf
                    break
                }
            }
            val itf = found ?: throw IllegalStateException("No J-Link vendor interface")
            var inEp: UsbEndpoint? = null
            var outEp: UsbEndpoint? = null
            for (i in 0 until itf.endpointCount) {
                val ep = itf.getEndpoint(i)
                if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
                if (ep.direction == UsbConstants.USB_DIR_IN) inEp = ep else outEp = ep
            }
            if (inEp == null || outEp == null) throw IllegalStateException("Bulk endpoints not found")
            val c = manager().openDevice(dev) ?: throw IllegalStateException("openDevice failed (no permission?)")
            if (!c.claimInterface(itf, true)) {
                c.close()
                throw IllegalStateException("claimInterface failed")
            }
            conn = c
            iface = itf
            epIn = inEp
            epOut = outEp
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
            var tries = 2
            while (off < data.size) {
                val n = c.bulkTransfer(eo, data, off, minOf(CHUNK, data.size - off), TIMEOUT_MS)
                if (n < 0) {
                    if (--tries == 0) {
                        rxPos = 0
                        rxLen = 0
                        throw IllegalStateException("USB write failed/timeout")
                    }
                    continue
                }
                tries = 2
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
                    }
                    if (n <= 0) {
                        rxPos = 0
                        rxLen = 0
                        throw IllegalStateException("USB read timeout")
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
        rxPos = 0
        rxLen = 0
    }
}
