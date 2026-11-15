import java.lang.reflect.*;
import java.util.UUID;

/** Exercises installed, unmodified 26.x server classes without opening a world. */
public final class ActualProbe {
    public static void main(String[] args) throws Exception {
        boolean offline = Boolean.parseBoolean(args[0]);
        Class.forName("net.minecraft.SharedConstants").getMethod("tryDetectVersion").invoke(null);
        Class.forName("net.minecraft.server.Bootstrap").getMethod("bootStrap").invoke(null);
        Class<?> unsafeClass = Class.forName("sun.misc.Unsafe");
        Field unsafeField = unsafeClass.getDeclaredField("theUnsafe");
        unsafeField.setAccessible(true);
        Object unsafe = unsafeField.get(null);
        Method allocate = unsafeClass.getMethod("allocateInstance", Class.class);
        Class<?> base = Class.forName("net.minecraft.server.MinecraftServer");
        Object world = allocate.invoke(unsafe, Class.forName("net.minecraft.client.server.IntegratedServer"));
        Object dedicated = allocate.invoke(unsafe, Class.forName("net.minecraft.server.dedicated.DedicatedServer"));
        Method set = base.getMethod("setUsesAuthentication", boolean.class);
        Method get = base.getMethod("usesAuthentication");
        set.invoke(world, true);
        set.invoke(dedicated, true);
        if ((Boolean) get.invoke(world) != !offline || !(Boolean) get.invoke(dedicated)) {
            throw new AssertionError("Wrong server authentication scope");
        }
        Method keys = base.getDeclaredMethod("initializeKeyPair");
        keys.setAccessible(true);
        keys.invoke(world);
        keys.invoke(dedicated);
        String worldState = loginState(base, world);
        String dedicatedState = loginState(base, dedicated);
        if (!(offline ? "VERIFYING" : "KEY").equals(worldState) || !"KEY".equals(dedicatedState)) {
            throw new AssertionError("Wrong login handshake: " + worldState + ", " + dedicatedState);
        }
        System.out.println("Actual Minecraft: integrated=" + worldState + ", dedicated=" + dedicatedState);
    }

    private static String loginState(Class<?> base, Object server) throws Exception {
        Class<?> flow = Class.forName("net.minecraft.network.protocol.PacketFlow");
        Object serverbound = flow.getField("SERVERBOUND").get(null);
        Class<?> connection = Class.forName("net.minecraft.network.Connection");
        Object channel = connection.getConstructor(flow).newInstance(serverbound);
        Class<?> listener = Class.forName("net.minecraft.server.network.ServerLoginPacketListenerImpl");
        Object login = listener.getConstructor(base, connection, boolean.class).newInstance(server, channel, false);
        Class<?> hello = Class.forName("net.minecraft.network.protocol.login.ServerboundHelloPacket");
        Object packet = hello.getConstructor(String.class, UUID.class).newInstance("OfflineGuest", UUID.randomUUID());
        listener.getMethod("handleHello", hello).invoke(login, packet);
        Field state = listener.getDeclaredField("state");
        state.setAccessible(true);
        return state.get(login).toString();
    }
}
