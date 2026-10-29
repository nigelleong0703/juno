package io.github.nigelleong0703.juno.ui.onboarding

import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.ProviderDisplay
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.settings.ShowMoreButton
import io.github.nigelleong0703.juno.ui.settings.models.AddProviderSheet
import io.github.nigelleong0703.juno.ui.settings.models.ChatGptSignInSheet
import io.github.nigelleong0703.juno.ui.settings.models.ModelPickerSheet
import io.github.nigelleong0703.juno.ui.settings.models.ModelsViewModel
import io.github.nigelleong0703.juno.ui.components.GroupedChoiceRow
import io.github.nigelleong0703.juno.ui.settings.models.PickKind
import io.github.nigelleong0703.juno.ui.settings.models.ProviderForm
import io.github.nigelleong0703.juno.ui.settings.models.ProviderKeySheet
import io.github.nigelleong0703.juno.ui.settings.models.DefaultDraft
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/**
 * Wraps the signed-in content. While the provider list is unknown the content shows (iOS RootView). When the server says no
 * model is usable, the gate replaces it (iOS ConnectModel.swift): not dismissable, the only exit is Log out. It never
 * navigates; the content appears by itself when `usable` turns true.
 */
@Composable
fun ConnectModelGate(content: @Composable () -> Unit) {
    val world = LocalWorld.current
    val vm: ModelsViewModel = viewModel { ModelsViewModel(world) }
    val list by vm.providers.collectAsState()
    if (list?.usable == false) ConnectModelScreen(vm) else content()
}

@Composable
private fun ConnectModelScreen(vm: ModelsViewModel) {
    val c = JunoTheme.colors
    val world = LocalWorld.current
    val list by vm.providers.collectAsState()
    val keyed = list?.providers.orEmpty().filter(ProviderDisplay::eligibleForChat)
    Column(
        Modifier.fillMaxSize().background(c.canvas).systemBarsPadding().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        if (keyed.isEmpty()) ConnectStep(vm) else ChooseModelStep(vm, keyed)
        Spacer(Modifier.height(16.dp))
        Text(
            "Log out", style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fgMuted,
            modifier = Modifier.clickable { world.signOut() }.padding(8.dp),
        )
    }
}

/** Step 1: no provider with a key yet. Connect a ChatGPT subscription or add an API key. */
@Composable
private fun ConnectStep(vm: ModelsViewModel) {
    val c = JunoTheme.colors
    var sheet by remember { mutableStateOf<GateSheet?>(null) }
    Text("Connect a model", style = junoText(TextSize.Xxl, FontWeight.Bold), color = c.fg, textAlign = TextAlign.Center)
    Text(
        "Connect a model so your agent can start. Use your ChatGPT subscription or your own API key.",
        style = junoText(TextSize.Lg), color = c.fgMuted, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 10.dp, bottom = 28.dp),
    )
    JunoButton("Continue with ChatGPT", { sheet = GateSheet.ChatGpt }, Modifier.fillMaxWidth())
    Spacer(Modifier.height(12.dp))
    JunoButton("Use an API key", { sheet = GateSheet.Add }, Modifier.fillMaxWidth(), ButtonVariant.Secondary)
    when (val s = sheet) {
        null -> {}
        GateSheet.ChatGpt -> ChatGptSignInSheet(vm, onDismiss = { sheet = null })
        GateSheet.Add -> AddProviderSheet(vm, firstRun = true, onDismiss = { sheet = null }, onForm = { sheet = GateSheet.Form(it) }, onChatGpt = { sheet = GateSheet.ChatGpt })
        is GateSheet.Form -> ProviderKeySheet(vm, s.form, onDismiss = { sheet = null }, onChatGpt = { sheet = GateSheet.ChatGpt })
    }
}

/** Step 2: a provider has a key but no default model. Pick one (first five, or all). Continue stays off until picked. */
@Composable
private fun ChooseModelStep(vm: ModelsViewModel, keyed: List<io.github.nigelleong0703.juno.contract.ModelProvider>) {
    val c = JunoTheme.colors
    val draft by vm.draft.collectAsState()
    val catalogs by vm.catalogs.collectAsState()
    val scope = rememberCoroutineScope()
    var showAll by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(keyed.map { it.id }) {
        if (vm.providerOf(draft.providerId)?.let(ProviderDisplay::eligibleForChat) != true) vm.pickProvider(keyed.first().id)
    }
    val providerId = draft.providerId ?: keyed.first().id
    LaunchedEffect(providerId) { error = vm.loadCatalog(providerId) }
    val provider = keyed.firstOrNull { it.id == providerId } ?: keyed.first()
    val items = catalogs[providerId]?.items.orEmpty()

    // The full searchable list, shared with the Models page default picker.
    if (showAll) ModelPickerSheet(vm, PickKind.Default, onDismiss = { showAll = false })

    Text("Choose a model", style = junoText(TextSize.Xxl, FontWeight.Bold), color = c.fg, textAlign = TextAlign.Center)
    Text(
        "Pick the model your agents use. You can change it later in Models.",
        style = junoText(TextSize.Lg), color = c.fgMuted, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 10.dp, bottom = 20.dp),
    )
    if (keyed.size > 1) {
        GroupedSection(header = "Provider") {
            keyed.forEach { p -> GroupedChoiceRow(p.name ?: p.id, selected = p.id == providerId, onClick = { vm.pickProvider(p.id) }) }
        }
    } else {
        GroupedSection { GroupedRow("Provider", value = provider.name ?: provider.id) }
    }
    GroupedSection(header = "Model") {
        items.take(FIRST_MODELS).forEach { m ->
            GroupedChoiceRow(m.name ?: m.id, selected = draft.model == m.id, onClick = { vm.setDraft(DefaultDraft(providerId, m.id)) })
        }
        if (items.size > FIRST_MODELS) ShowMoreButton("Show all models") { showAll = true }
    }
    error?.let { SettingsError(it) }
    Spacer(Modifier.height(16.dp))
    JunoButton(
        if (busy) "Saving…" else "Continue",
        { scope.launch { busy = true; error = vm.saveDefault(); busy = false } },
        Modifier.fillMaxWidth(), enabled = draft.model != null && !busy,
    )
}

private const val FIRST_MODELS = 5

private sealed interface GateSheet {
    data object ChatGpt : GateSheet
    data object Add : GateSheet
    data class Form(val form: ProviderForm) : GateSheet
}
