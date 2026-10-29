package io.github.nigelleong0703.juno.ui.settings.models

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.nigelleong0703.juno.contract.AppSettingsResponse
import io.github.nigelleong0703.juno.contract.ModelCatalog
import io.github.nigelleong0703.juno.contract.ModelCatalogItem
import io.github.nigelleong0703.juno.contract.ModelProvider
import io.github.nigelleong0703.juno.contract.ModelProviderList
import io.github.nigelleong0703.juno.contract.SystemOneModelChoice
import io.github.nigelleong0703.juno.contract.TierRow
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.ModelErrors
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.state.addBuiltinProvider
import io.github.nigelleong0703.juno.state.addCustomProvider
import io.github.nigelleong0703.juno.state.addSystemOneProvider
import io.github.nigelleong0703.juno.state.completeChatGptLogin
import io.github.nigelleong0703.juno.state.loadModelProviders
import io.github.nigelleong0703.juno.state.loadModelSettings
import io.github.nigelleong0703.juno.state.loadPlatformCatalog
import io.github.nigelleong0703.juno.state.loadProviderCatalog
import io.github.nigelleong0703.juno.state.removeModelProvider
import io.github.nigelleong0703.juno.state.renameModelProvider
import io.github.nigelleong0703.juno.state.replaceModelProviderKey
import io.github.nigelleong0703.juno.state.PLATFORM_KEY
import io.github.nigelleong0703.juno.state.TIER_KEYS
import io.github.nigelleong0703.juno.state.saveDefaultModel
import io.github.nigelleong0703.juno.state.saveSystemOneModel
import io.github.nigelleong0703.juno.state.saveTiers
import io.github.nigelleong0703.juno.state.saveWebSearch
import io.github.nigelleong0703.juno.state.startChatGptLogin
import io.github.nigelleong0703.juno.state.ChatGptLogin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The default-model choice being edited. Survives leaving the picker, so an unsaved pick is never overwritten by a reload. */
data class DefaultDraft(val providerId: String? = null, val model: String? = null)

/**
 * Everything the Models screens read and change (iOS ModelSettings.swift and BackgroundModels.swift, plus the connect gate).
 * Each change goes to the server and then re-reads the lists, so a row never shows a value the server did not keep.
 */
class ModelsViewModel(private val world: World) : ViewModel() {
    private val _providers = MutableStateFlow<ModelProviderList?>(null)
    val providers: StateFlow<ModelProviderList?> = _providers.asStateFlow()

    private val _settings = MutableStateFlow<AppSettingsResponse?>(null)
    val settings: StateFlow<AppSettingsResponse?> = _settings.asStateFlow()

    private val _catalogs = MutableStateFlow<Map<String, ModelCatalog>>(emptyMap())
    val catalogs: StateFlow<Map<String, ModelCatalog>> = _catalogs.asStateFlow()

    private val _draft = MutableStateFlow(DefaultDraft())
    val draft: StateFlow<DefaultDraft> = _draft.asStateFlow()

    /** A failed read shown at the top of the screen (iOS "Error line"). Cleared by the next good read. */
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /** The tier row being edited (Models → What each job runs on); [openTier] fills it from the saved row. */
    private val _tierDraft = MutableStateFlow(TierRow())
    val tierDraft: StateFlow<TierRow> = _tierDraft.asStateFlow()

    private var draftReady = false

    init { reload() }

    fun reload() {
        viewModelScope.launch {
            runCatching { world.loadModelProviders() }
                .onSuccess { _providers.value = it; _error.value = null }
                .onFailure { if (!it.isCancellation) _error.value = it.userMessage }
            runCatching { world.loadModelSettings() }.onSuccess { s ->
                _settings.value = s
                // The draft starts from the saved choice once; after that the user's pick wins until it is saved.
                if (!draftReady) {
                    _draft.value = DefaultDraft(s.models?.providerId, s.models?.defaultModel)
                    draftReady = true
                }
            }
        }
    }

    /**
     * Runs one change, then re-reads the lists. Returns the user copy of a failure, or null when it went through. Screens
     * keep their sheet open on a failure, so the reason sits next to the field that caused it.
     */
    suspend fun attempt(change: suspend () -> Unit): String? {
        val failure = try {
            change(); null
        } catch (e: Throwable) {
            if (e.isCancellation) throw e
            ModelErrors.saveMessage(e)
        }
        reload()
        return failure
    }

    suspend fun addBuiltin(providerId: String, apiKey: String) = attempt { world.addBuiltinProvider(providerId, apiKey) }
    suspend fun addSystemOne(name: String, baseUrl: String, models: List<String>, apiKey: String) =
        attempt { world.addSystemOneProvider(name, baseUrl, models, apiKey) }
    suspend fun addCustom(name: String, baseUrl: String, wire: String, apiKey: String) =
        attempt { world.addCustomProvider(name, baseUrl, wire, apiKey) }
    suspend fun rename(id: String, name: String) = attempt { world.renameModelProvider(id, name) }
    suspend fun replaceKey(id: String, apiKey: String) = attempt { world.replaceModelProviderKey(id, apiKey) }
    suspend fun remove(id: String) = attempt { world.removeModelProvider(id) }

    /** Opens the ChatGPT sign-in link. Null on failure, with the reason in the returned pair's second part. */
    suspend fun startChatGpt(): Pair<ChatGptLogin?, String?> {
        var login: ChatGptLogin? = null
        val failure = attempt { login = world.startChatGptLogin() }
        return login to failure
    }

    /**
     * Sends the pasted address. Returns the failure copy and, when the login is spent, the reason: the caller then starts a
     * fresh login and clears the paste. Other failures keep the paste.
     */
    suspend fun completeChatGpt(loginId: String, callbackUrl: String): Pair<String?, String?> {
        var spent: String? = null
        val failure = attempt {
            try {
                world.completeChatGptLogin(loginId, callbackUrl)
            } catch (e: Throwable) {
                spent = ModelErrors.spentChatGptLogin(e)
                throw e
            }
        }
        return failure to spent
    }

    /** Loads a provider's model list once. Returns the user copy of a failure. */
    suspend fun loadCatalog(providerId: String): String? {
        if (_catalogs.value.containsKey(providerId)) return null
        return try {
            val catalog = if (providerId == PLATFORM_KEY) world.loadPlatformCatalog() else world.loadProviderCatalog(providerId)
            _catalogs.update { it + (providerId to catalog) }
            null
        } catch (e: Throwable) {
            if (e.isCancellation) throw e
            ModelErrors.catalogMessage(e)
        }
    }

    fun setDraft(draft: DefaultDraft) { _draft.value = draft }

    /** Picking a provider clears the model that belonged to the old one. */
    fun pickProvider(providerId: String) { _draft.update { DefaultDraft(providerId = providerId) } }

    fun pickModel(model: String) { _draft.update { it.copy(model = model) } }

    suspend fun saveDefault(): String? {
        val d = _draft.value
        return attempt { world.saveDefaultModel(d.providerId, d.model) }
    }

    suspend fun clearDefault(): String? = attempt {
        world.saveDefaultModel(null, null)
        _draft.value = DefaultDraft()
    }

    suspend fun saveWebSearch(mode: String): String? = attempt { world.saveWebSearch(mode) }

    suspend fun saveSystemOne(choice: SystemOneModelChoice?): String? = attempt { world.saveSystemOneModel(choice) }

    /** The saved rows of `models.tiers`, by key. */
    fun savedTiers(): Map<String, TierRow> = _settings.value?.models?.tiers?.let {
        mapOf("chat" to it.chat, "task" to it.task, "deep" to it.deep, "fast" to it.fast).filterValues { row -> row != null }.mapValues { e -> e.value!! }
    } ?: emptyMap()

    fun openTier(key: String) { _tierDraft.value = savedTiers()[key] ?: TierRow() }

    /** Picking a model (null is "Default") drops an effort the new model does not list; Quick jobs without a model has none. */
    fun pickTierModel(choice: SystemOneModelChoice?) {
        // The platform source is saved as a model id alone.
        val providerId = choice?.providerId?.takeIf { it != PLATFORM_KEY }
        val item = catalogItem(providerId, choice?.modelId)
        _tierDraft.update { row ->
            val keep = row.effort?.takeIf { e -> choice?.modelId != null && item?.reasoningEfforts?.contains(e) == true }
            TierRow(providerId = providerId, modelId = choice?.modelId, effort = keep)
        }
    }

    fun pickTierEffort(effort: String?) { _tierDraft.update { it.copy(effort = effort) } }

    /** Saves [row] as this key's row with every other saved row kept; an empty row is "Default". */
    suspend fun saveTier(key: String, row: TierRow): String? {
        val all = savedTiers().toMutableMap()
        all[key] = row
        return attempt { world.saveTiers(all.filterKeys { it in TIER_KEYS }) }
    }

    /** A model's catalog entry; a null provider is the platform's own endpoint. */
    fun catalogItem(providerId: String?, model: String?): ModelCatalogItem? =
        _catalogs.value[providerId ?: PLATFORM_KEY]?.items?.firstOrNull { it.id == model }

    /** The provider the draft points at, when it is still in the list. */
    fun providerOf(id: String?): ModelProvider? = _providers.value?.providers?.firstOrNull { it.id == id }
}
