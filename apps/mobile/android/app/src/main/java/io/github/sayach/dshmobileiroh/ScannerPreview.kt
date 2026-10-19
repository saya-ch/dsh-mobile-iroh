package io.github.sayach.dshmobileiroh

import android.content.Context
import android.view.MotionEvent
import android.view.SurfaceView

/** Owns complete touch sequences; scanner zoom buttons provide accessible equivalents. */
internal class ScannerPreview(context: Context) : SurfaceView(context) {
    var gestureEvents: ((MotionEvent) -> Unit)? = null

    override fun onTouchEvent(event: MotionEvent): Boolean {
        gestureEvents?.invoke(event)
        if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }
}
