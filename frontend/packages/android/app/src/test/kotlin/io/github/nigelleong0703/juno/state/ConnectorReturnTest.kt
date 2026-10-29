package io.github.nigelleong0703.juno.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectorReturnTest {
    @Test fun `a connected return carries the connection id`() {
        assertEquals(
            ConnectorReturn("conn_1", ConnectorStatus.Connected),
            parseConnectorReturn("juno://connectors?connection=conn_1&status=connected"),
        )
    }

    @Test fun `an error return is a failure`() {
        assertEquals(ConnectorReturn("conn_1", ConnectorStatus.Failed), parseConnectorReturn("juno://connectors?connection=conn_1&status=error"))
    }

    @Test fun `a bare return or an unknown status is unknown, not a failure`() {
        assertEquals(ConnectorReturn(null, ConnectorStatus.Unknown), parseConnectorReturn("juno://connectors"))
        assertEquals(ConnectorReturn(null, ConnectorStatus.Unknown), parseConnectorReturn("juno://connectors/"))
        assertEquals(ConnectorReturn(null, ConnectorStatus.Unknown), parseConnectorReturn("juno://connectors?status=later"))
        assertEquals(ConnectorReturn(null, ConnectorStatus.Connected), parseConnectorReturn("juno://connectors?connection=&status=connected"))
    }

    @Test fun `other schemes and hosts are not connector returns`() {
        assertNull(parseConnectorReturn("https://connectors?status=connected"))
        assertNull(parseConnectorReturn("juno://today?status=connected"))
        assertNull(parseConnectorReturn("juno://connectors.evil.example/x"))
        assertNull(parseConnectorReturn("agentdesktop://plugins?tab=connectors"))
    }

    @Test fun `scheme and host match regardless of case, and the value is decoded`() {
        assertEquals(ConnectorReturn("a b&c", ConnectorStatus.Connected), parseConnectorReturn("JUNO://Connectors?connection=a%20b%26c&status=connected"))
    }

    @Test fun `garbage and empty input are not returns`() {
        assertNull(parseConnectorReturn(null))
        assertNull(parseConnectorReturn("   "))
        assertNull(parseConnectorReturn("not a uri with spaces"))
    }
}
