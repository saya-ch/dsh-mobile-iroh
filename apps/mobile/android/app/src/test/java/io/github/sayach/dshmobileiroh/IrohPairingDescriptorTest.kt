package io.github.sayach.dshmobileiroh

import java.io.IOException
import java.time.Instant
import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class IrohPairingDescriptorTest {
    private val now = Instant.parse("2026-10-21T00:00:00Z").toEpochMilli()
    private val binding = IrohDeviceBinding("a".repeat(64), 25443)
    private fun descriptor() = JSONObject()
        .put("version", 1).put("type", "dsh-mobile-iroh-pairing")
        .put("endpointId", binding.endpointId).put("localPort", binding.localPort).put("origin", binding.origin.serialized)
        .put("irohCode", "123456").put("gatewayToken", "A".repeat(43))
        .put("caCertificate", Base64.getEncoder().encodeToString(TestCertificates.ingressCa))
        .put("instanceId", TestCertificates.instanceIdOf(TestCertificates.ingressCa)).put("expiresAt", now + 60_000)

    @Test
    fun validatesScannedPublicCaAndKeepsSecretsOutOfToString() {
        val parsed = IrohPairingDescriptor.parse(descriptor().toString(), now)
        assertEquals(binding, parsed.binding)
        assertArrayEquals(TestCertificates.ingressCa, parsed.caCertificate)
        assertFalse(parsed.toString().contains("123456"))
        assertFalse(parsed.toString().contains("A".repeat(43)))
        assertEquals(binding, IrohPairingDescriptor.parse(descriptor().toString().replace("\"version\":1", "\"version\":1e0"), now).binding)
    }

    @Test
    fun theExistingScannerDecodesTheFullCertificateBearingDescriptor() {
        val encoded = descriptor().toString()
        val size = 900
        val qr = com.google.zxing.qrcode.QRCodeWriter().encode(encoded, com.google.zxing.BarcodeFormat.QR_CODE,
            size, size, mapOf(com.google.zxing.EncodeHintType.ERROR_CORRECTION to com.google.zxing.qrcode.decoder.ErrorCorrectionLevel.M))
        val luminance = ByteArray(size * size) { index -> if (qr[index % size, index / size]) 0 else 255.toByte() }
        assertEquals(encoded, QrDecoder.decodeNv21(luminance, size, size))
    }

    @Test
    fun descriptorByteBudgetFitsTheSharedMediumCorrectionQrCapacity() {
        assertEquals(2200, IrohPairingDescriptor.MAX_BYTES)
        val atLimit = descriptor().toString().padEnd(IrohPairingDescriptor.MAX_BYTES, ' ')
        assertEquals(2200, atLimit.toByteArray(Charsets.UTF_8).size)
        assertEquals(binding, IrohPairingDescriptor.parse(atLimit, now).binding)
        com.google.zxing.qrcode.QRCodeWriter().encode(atLimit, com.google.zxing.BarcodeFormat.QR_CODE,
            900, 900, mapOf(com.google.zxing.EncodeHintType.ERROR_CORRECTION to com.google.zxing.qrcode.decoder.ErrorCorrectionLevel.M))
        assertThrows(IOException::class.java) { IrohPairingDescriptor.parse(atLimit + " ", now) }
    }

    @Test
    fun rejectsUnknownDuplicateNonJsonAndOversizedPayloadsBeforeParsingNestedData() {
        val valid = descriptor().toString()
        for (text in listOf(
            valid.dropLast(1) + ",\"version\":1}",
            valid.dropLast(1) + ",\"version\":1,\"unknown\":true}",
            valid.dropLast(1) + ",}",
            valid.replace("\"version\":1", "version:1"),
            valid.replace("\"version\":1", "'version':1"),
            valid.replace("\"version\":1", "\"version\":01"),
            valid.replace("\"version\":1", "/* comment */\"version\":1"),
            valid + " ".repeat(IrohPairingDescriptor.MAX_BYTES),
            "[".repeat(1400) + "]".repeat(1400),
        )) assertThrows(IOException::class.java) { IrohPairingDescriptor.parse(text, now) }
    }

    @Test
    fun rejectsIdentityOriginCodesExpiryAndCertificateSubstitution() {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { it.put("version", 2) }, { it.put("type", "other") },
            { it.put("endpointId", "A".repeat(64)) }, { it.put("localPort", 1023) },
            { it.put("origin", "https://other.example") }, { it.put("origin", binding.origin.serialized + "/") },
            { it.put("irohCode", "１２３４５６") }, { it.put("gatewayToken", "B".repeat(43)) },
            { it.put("expiresAt", now) }, { it.put("expiresAt", now + 600_001) },
            { it.put("instanceId", "b".repeat(64)) },
            { it.put("caCertificate", Base64.getEncoder().encodeToString(TestCertificates.foreignCa)) },
            { it.put("caCertificate", Base64.getEncoder().encodeToString(TestCertificates.ingressCa + byteArrayOf(0))) },
            { it.put("caCertificate", Base64.getEncoder().encodeToString(TestCertificates.expiredCa)).put("instanceId", TestCertificates.instanceIdOf(TestCertificates.expiredCa)) },
        )
        for (mutate in mutations) {
            val value = descriptor().also(mutate)
            assertThrows(IOException::class.java) { IrohPairingDescriptor.parse(value.toString(), now) }
        }
    }
}
