package sfmcl.lan;

import java.io.*;
import java.lang.instrument.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.ProtectionDomain;
import java.util.*;
import java.util.jar.*;

/** Opt-in LAN authentication override. No client auth or dedicated server changes. */
public final class OfflineLanAgent {
    private static final String SERVER = "net.minecraft.server.MinecraftServer";
    private static final String INTEGRATED = "net.minecraft.client.server.IntegratedServer";

    public static void premain(String arguments, Instrumentation instrumentation) {
        final String[] target = arguments == null ? new String[0] : arguments.split(",", -1);
        if (target.length != 3) throw new IllegalArgumentException("Invalid offline LAN target");
        for (String name : target) {
            if (!name.matches("[A-Za-z_$][A-Za-z0-9_$/]*")) {
                throw new IllegalArgumentException("Invalid offline LAN class/method name");
            }
        }
        instrumentation.addTransformer(new ClassFileTransformer() {
            public byte[] transform(ClassLoader loader, String name, Class<?> redefining,
                                    ProtectionDomain domain, byte[] bytes) {
                if (!target[1].equals(name)) return null;
                try {
                    ClassFile file = new ClassFile(bytes);
                    if (!file.name().equals(target[1]) || !file.parent().equals(target[0])) {
                        throw new IOException("Integrated server superclass changed");
                    }
                    byte[] patched = file.overrideBoolean(target[2]);
                    System.out.println("[SFMCL Offline LAN] Enabled for the integrated server only");
                    return patched;
                } catch (Exception error) {
                    System.err.println("[SFMCL Offline LAN] Unsupported integrated server: " + error.getMessage());
                    // A transformer exception is ignored by the JVM. Reject this class instead
                    // of silently starting a world with online verification still enabled.
                    return new byte[0];
                }
            }
        }, false);
        System.out.println("[SFMCL Offline LAN] Agent ready; external server authentication unchanged");
    }

    /** Read-only preflight, run with the selected game JRE before launching Minecraft. */
    public static void main(String[] arguments) throws Exception {
        if (arguments.length < 2 || arguments.length > 3 || !"--check".equals(arguments[0])) {
            throw new IllegalArgumentException("Usage: --check client.jar [client-mappings.txt]");
        }
        String server = SERVER.replace('.', '/');
        String integrated = INTEGRATED.replace('.', '/');
        String getter = "usesAuthentication";
        if (arguments.length == 3) {
            String current = "";
            for (String line : Files.readAllLines(Paths.get(arguments[2]), StandardCharsets.UTF_8)) {
                if (line.startsWith("#") || line.trim().isEmpty()) continue;
                int arrow = line.lastIndexOf(" -> ");
                if (arrow < 0) continue;
                if (!Character.isWhitespace(line.charAt(0)) && line.endsWith(":")) {
                    current = line.substring(0, arrow);
                    String mapped = line.substring(arrow + 4, line.length() - 1).replace('.', '/');
                    if (SERVER.equals(current)) server = mapped;
                    if (INTEGRATED.equals(current)) integrated = mapped;
                } else if (SERVER.equals(current) && line.contains("boolean usesAuthentication() -> ")) {
                    getter = line.substring(arrow + 4).trim();
                }
            }
        }
        try (JarFile jar = new JarFile(arguments[1])) {
            ClassFile base = new ClassFile(readEntry(jar, server + ".class"));
            ClassFile world = new ClassFile(readEntry(jar, integrated + ".class"));
            if (!base.hasOverridableBoolean(getter) || !world.parent().equals(server)) {
                throw new IOException("Minecraft authentication layout is unsupported");
            }
            world.overrideBoolean(getter);
        }
        System.out.println(server + "," + integrated + "," + getter);
    }

    private static byte[] readEntry(JarFile jar, String name) throws IOException {
        JarEntry entry = jar.getJarEntry(name);
        if (entry == null || entry.getSize() > 4 * 1024 * 1024) {
            throw new IOException("Missing or oversized Minecraft class: " + name);
        }
        try (InputStream input = jar.getInputStream(entry)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > 4 * 1024 * 1024) throw new IOException("Class too large");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    /** Preserve the class file verbatim except for one straight-line boolean override.
     * No ASM, loader dependencies, reflection, branches or stack-map rewriting. */
    static final class ClassFile {
        final byte[] bytes;
        final String[] strings;
        final int[] classes;
        final int poolCount, poolEnd, methodsOffset, methodsEnd;
        final List<int[]> methods = new ArrayList<int[]>();
        final int thisClass, superClass;

        ClassFile(byte[] bytes) throws IOException {
            this.bytes = bytes;
            Cursor input = new Cursor(bytes);
            if (input.u4() != 0xcafebabeL) throw new IOException("Invalid class file");
            input.skip(4);
            poolCount = input.u2();
            strings = new String[poolCount];
            classes = new int[poolCount];
            for (int index = 1; index < poolCount; index++) {
                int tag = input.u1();
                switch (tag) {
                    case 1:
                        int length = input.u2();
                        strings[index] = new String(bytes, input.position, length, StandardCharsets.UTF_8);
                        input.skip(length);
                        break;
                    case 7: classes[index] = input.u2(); break;
                    case 8: case 16: case 19: case 20: input.skip(2); break;
                    case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18:
                        input.skip(4); break;
                    case 5: case 6: input.skip(8); index++; break;
                    case 15: input.skip(3); break;
                    default: throw new IOException("Unsupported constant pool tag: " + tag);
                }
            }
            poolEnd = input.position;
            input.skip(2);
            thisClass = input.u2();
            superClass = input.u2();
            input.skip(input.u2() * 2);
            int fields = input.u2();
            for (int i = 0; i < fields; i++) {
                input.skip(6);
                skipAttributes(input);
            }
            methodsOffset = input.position;
            int count = input.u2();
            for (int i = 0; i < count; i++) {
                int start = input.position;
                int access = input.u2(), name = input.u2(), descriptor = input.u2();
                skipAttributes(input);
                methods.add(new int[]{start, input.position, access, name, descriptor});
            }
            methodsEnd = input.position;
            skipAttributes(input);
            if (input.position != bytes.length) throw new IOException("Trailing class bytes");
        }

        private static void skipAttributes(Cursor input) throws IOException {
            int count = input.u2();
            for (int i = 0; i < count; i++) {
                input.skip(2);
                long length = input.u4();
                if (length > Integer.MAX_VALUE) throw new IOException("Attribute too large");
                input.skip((int) length);
            }
        }

        String name() { return strings[classes[thisClass]]; }
        String parent() { return superClass == 0 ? "" : strings[classes[superClass]]; }

        boolean hasOverridableBoolean(String name) {
            for (int[] method : methods) {
                if (name.equals(strings[method[3]]) && "()Z".equals(strings[method[4]])) {
                    return (method[2] & 1) != 0 && (method[2] & (8 | 16)) == 0;
                }
            }
            return false;
        }

        byte[] overrideBoolean(String getter) throws IOException {
            int[] existing = null;
            for (int[] method : methods) {
                if (getter.equals(strings[method[3]]) && "()Z".equals(strings[method[4]])) {
                    if ((method[2] & (2 | 8)) != 0) throw new IOException("Getter is private or static");
                    existing = method;
                }
            }
            if (poolCount > 65532 || (existing == null && methods.size() == 65535)) {
                throw new IOException("Class limits exceeded");
            }
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(bytes.length + 80);
            DataOutputStream output = new DataOutputStream(buffer);
            output.write(bytes, 0, 8);
            output.writeShort(poolCount + 3);
            output.write(bytes, 10, poolEnd - 10);
            for (String value : new String[]{getter, "()Z", "Code"}) {
                output.writeByte(1);
                output.writeUTF(value);
            }
            output.write(bytes, poolEnd, methodsOffset - poolEnd);
            output.writeShort(methods.size() + (existing == null ? 1 : 0));
            for (int[] method : methods) {
                if (method != existing) output.write(bytes, method[0], method[1] - method[0]);
            }
            output.writeShort(1); // public instance method
            output.writeShort(poolCount);
            output.writeShort(poolCount + 1);
            output.writeShort(1);
            output.writeShort(poolCount + 2);
            output.writeInt(14); // Code attribute length
            output.writeShort(1); // max_stack
            output.writeShort(1); // max_locals: this
            output.writeInt(2);
            output.writeByte(3); // iconst_0
            output.writeByte(172); // ireturn
            output.writeShort(0); // exception table
            output.writeShort(0); // nested attributes (straight-line code needs no frames)
            output.write(bytes, methodsEnd, bytes.length - methodsEnd);
            return buffer.toByteArray();
        }
    }

    private static final class Cursor {
        final byte[] bytes;
        int position;
        Cursor(byte[] bytes) { this.bytes = bytes; }
        void skip(int count) throws IOException {
            if (count < 0 || count > bytes.length - position) throw new EOFException("Truncated class file");
            position += count;
        }
        int u1() throws IOException { skip(1); return bytes[position - 1] & 255; }
        int u2() throws IOException { return (u1() << 8) | u1(); }
        long u4() throws IOException { return ((long) u2() << 16) | u2(); }
    }
}
