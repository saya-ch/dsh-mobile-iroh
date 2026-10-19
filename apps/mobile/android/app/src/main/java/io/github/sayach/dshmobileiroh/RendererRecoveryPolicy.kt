package io.github.sayach.dshmobileiroh

/** A renderer that repeatedly dies should stop automatic page recreation. */
internal data class RendererRecoveryDecision(val recentCrashes: List<Long>, val retry: Boolean)

internal fun rendererRecoveryDecision(recentCrashes: List<Long>, nowElapsedMs: Long): RendererRecoveryDecision {
    val recent = recentCrashes.filter { nowElapsedMs - it in 0L until 60_000L } + nowElapsedMs
    return RendererRecoveryDecision(recent, recent.size < 3)
}
