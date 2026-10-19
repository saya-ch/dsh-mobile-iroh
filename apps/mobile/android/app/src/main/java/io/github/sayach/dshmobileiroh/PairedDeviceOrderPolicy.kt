package io.github.sayach.dshmobileiroh

/**
 * Presentation order of the paired-device list.
 *
 * Rows keep their persisted display order; connection times select startup devices but do not
 * rearrange the list. The first upgrade persists the last-used order visible in older releases.
 *
 * Startup selection is deliberately independent of this order: `ConnectionRestorePolicy`
 * prefers the saved last-used key and otherwise the most recently connected valid row.
 */
internal object PairedDeviceOrderPolicy {
    enum class MigrationWrite { NONE, EMPTY_MARKER, SORTED_ROWS }
    data class InitialOrder(val rows: List<PairedDeviceRecord>, val write: MigrationWrite)

    /** Null means unreadable encrypted data: leave both the original payload and marker untouched. */
    fun initialOrder(decoded: List<PairedDeviceRecord>?, migrationComplete: Boolean): InitialOrder {
        if (decoded == null) return InitialOrder(emptyList(), MigrationWrite.NONE)
        if (migrationComplete) return InitialOrder(displayOrder(decoded), MigrationWrite.NONE)
        if (decoded.isEmpty()) return InitialOrder(decoded, MigrationWrite.EMPTY_MARKER)
        val visible = decoded.sortedWith(
            compareByDescending<PairedDeviceRecord> { it.lastConnectedAt ?: Long.MIN_VALUE }.thenBy { it.key },
        )
        return InitialOrder(visible, MigrationWrite.SORTED_ROWS)
    }

    /**
     * The rows in display order: the stored array already is that order.
     *
     * Rows append when they are paired and only the two arrangement actions move them, so this
     * deliberately ignores connection times — the device used last must not jump to the front.
     */
    fun displayOrder(rows: List<PairedDeviceRecord>): List<PairedDeviceRecord> = rows

    /** Whether one row can trade places with the row above it. */
    fun canMoveUp(rows: List<PairedDeviceRecord>, key: String): Boolean = indexOf(rows, key) > 0

    /** Whether one row can jump ahead of at least one other row. */
    fun canMoveToTop(rows: List<PairedDeviceRecord>, key: String): Boolean = indexOf(rows, key) > 1

    /** Move one row one position towards the front; an unknown key or the first row changes nothing. */
    fun moveUp(rows: List<PairedDeviceRecord>, key: String): List<PairedDeviceRecord> {
        val index = indexOf(rows, key)
        if (index <= 0) return rows
        return rows.toMutableList().apply { add(index - 1, removeAt(index)) }
    }

    /** Move one row to the front; an unknown key or the first row changes nothing. */
    fun moveToTop(rows: List<PairedDeviceRecord>, key: String): List<PairedDeviceRecord> {
        val index = indexOf(rows, key)
        if (index <= 0) return rows
        return rows.toMutableList().apply { add(0, removeAt(index)) }
    }

    private fun indexOf(rows: List<PairedDeviceRecord>, key: String): Int = rows.indexOfFirst { it.key == key }
}
