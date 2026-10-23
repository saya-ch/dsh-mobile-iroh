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
    fun certificateLengthStringsParseAtTheByteLimitBeforeAndAfterOtherFields() {
        val fields = descriptor()
        val ca = fields.getString("caCertificate")
        assertTrue("The regression needs a certificate-length JSON string", ca.length >= 1000)
        val certificateEntry = "\"caCertificate\":" + JSONObject.quote(ca)
        val remaining = fields.keys().asSequence().filter { it != "caCertificate" }.map { key ->
            val value = fields.get(key)
            JSONObject.quote(key) + ":" + if (value is String) JSONObject.quote(value) else value.toString()
        }.toList()
        for (entries in listOf(listOf(certificateEntry) + remaining, remaining + certificateEntry)) {
            val encoded = "{" + entries.joinToString(",") + "}"
            assertTrue(encoded.toByteArray(Charsets.UTF_8).size <= IrohPairingDescriptor.MAX_BYTES)
            val atLimit = encoded.padEnd(IrohPairingDescriptor.MAX_BYTES, ' ')
            val parsed = IrohPairingDescriptor.parse(atLimit, now)
            assertEquals(binding, parsed.binding)
            assertArrayEquals(TestCertificates.ingressCa, parsed.caCertificate)
        }
    }

    @Test
    fun standardEscapesAndExponentNumbersRemainJsonWhileEscapedDuplicateKeysAreRejected() {
        val valid = descriptor().toString()
        val escaped = valid.replace("\"version\":1", "\"\\u0076ersion\":1e0")
            .replace("https://", "https:\\/\\/")
            .replace("\"caCertificate\":\"M", "\"caCertificate\":\"\\u004d")
        assertTrue(escaped.contains("\"\\u0076ersion\":1e0"))
        assertTrue(escaped.contains("https:\\/\\/"))
        assertTrue(escaped.contains("\"caCertificate\":\"\\u004d"))
        assertTrue(escaped.toByteArray(Charsets.UTF_8).size <= IrohPairingDescriptor.MAX_BYTES)
        assertEquals(binding, IrohPairingDescriptor.parse(escaped, now).binding)
        for (suffix in listOf(
            ",\"version\":1}",
            ",\"\\u0076ersion\":1}",
            ",\"\\u0075nknown\":1}",
        )) {
            val encoded = valid.dropLast(1) + suffix
            assertTrue(encoded.toByteArray(Charsets.UTF_8).size <= IrohPairingDescriptor.MAX_BYTES)
            assertThrows(IOException::class.java) { IrohPairingDescriptor.parse(encoded, now) }
        }
    }

    @Test
    fun manyFlatUnknownFieldsRejectWithinTheDescriptorBudget() {
        val encoded = (0 until 200).joinToString(",", "{", "}") { "\"x$it\":0" }
        assertTrue(encoded.toByteArray(Charsets.UTF_8).size <= IrohPairingDescriptor.MAX_BYTES)
        assertThrows(IOException::class.java) { IrohPairingDescriptor.parse(encoded, now) }
    }

    @Test
    fun longEscapedStringsAndMalformedEscapeTailsRejectWithinTheDescriptorBudget() {
        val valid = descriptor().toString()
        val ca = descriptor().getString("caCertificate")
        for (payload in listOf(
            "\\x41", "\\u004", "\\u00G0",
            "\\u0041".repeat(200) + "\\u00G0",
            "\\\"".repeat(350) + "\\x",
            "\\\\".repeat(600) + "\\",
            "A".repeat(1200) + "\n",
            "A".repeat(1200) + "\u0000",
        )) {
            val encoded = valid.replace(JSONObject.quote(ca), "\"$payload\"")
            assertTrue(encoded.toByteArray(Charsets.UTF_8).size <= IrohPairingDescriptor.MAX_BYTES)
            assertThrows(IOException::class.java) { IrohPairingDescriptor.parse(encoded, now) }
        }
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
