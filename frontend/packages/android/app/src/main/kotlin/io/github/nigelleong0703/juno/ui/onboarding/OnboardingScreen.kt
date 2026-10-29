package io.github.nigelleong0703.juno.ui.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.character.SpriteView
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

private data class OnboardingPage(val title: String, val text: String, val character: String, val clip: String)

/** Copy and art from iOS Onboarding.swift:66-70 and 120-161. */
private val pages = listOf(
    OnboardingPage("A team that works for you", "Give each agent a job. They keep going while you get on with your day.", "purple", "working"),
    OnboardingPage("Every agent has its own computer", "A browser, files and a terminal, always on. Watch them work any time.", "blue", "idle"),
    OnboardingPage("You stay in control", "Agents ask before anything important. Approve, or take over the screen yourself.", "pink", "needs_you"),
)

/**
 * The first-run carousel (iOS OnboardingView). Skip is always visible; the last page's button reads "Get started". Both call
 * [onDone], which marks it seen. Off-page art scales and fades as the pager moves.
 */
@Composable
fun OnboardingScreen(onDone: () -> Unit) {
    val c = JunoTheme.colors
    val state = rememberPagerState(pageCount = { pages.size })
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().background(c.canvas).systemBarsPadding().padding(horizontal = 24.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Text(
                "Skip", style = junoText(TextSize.Md, FontWeight.Medium), color = c.fgMuted,
                modifier = Modifier.padding(vertical = 12.dp).clickable(onClick = onDone),
            )
        }
        HorizontalPager(state = state, modifier = Modifier.weight(1f)) { index ->
            val p = pages[index]
            val offset = (state.currentPage - index + state.currentPageOffsetFraction).let { kotlin.math.abs(it).coerceIn(0f, 1f) }
            Column(
                Modifier.fillMaxSize().graphicsLayer {
                    val s = 1f - 0.12f * offset
                    scaleX = s; scaleY = s; alpha = 1f - 0.6f * offset
                },
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                Box(Modifier.size(220.dp), contentAlignment = Alignment.Center) {
                    SpriteView(p.character, p.clip, 200.dp)
                }
                Spacer(Modifier.height(28.dp))
                Text(p.title, style = junoText(TextSize.Xxl, FontWeight.Bold), color = c.fg, textAlign = TextAlign.Center)
                Text(
                    p.text, style = junoText(TextSize.Lg), color = c.fgMuted, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 10.dp, start = 8.dp, end = 8.dp),
                )
            }
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.Center) {
            pages.indices.forEach { i ->
                Box(
                    Modifier.padding(horizontal = 4.dp).size(if (i == state.currentPage) 8.dp else 6.dp)
                        .background(if (i == state.currentPage) c.fg else c.border, androidx.compose.foundation.shape.CircleShape),
                )
            }
        }
        val last = state.currentPage == pages.size - 1
        JunoButton(
            if (last) "Get started" else "Continue",
            {
                if (last) onDone() else scope.launch { state.animateScrollToPage(state.currentPage + 1) }
            },
            Modifier.fillMaxWidth().padding(bottom = 24.dp),
            variant = ButtonVariant.Primary,
        )
    }
}
