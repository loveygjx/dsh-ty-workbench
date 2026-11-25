import com.sun.star.bridge.XUnoUrlResolver;
import com.sun.star.comp.helper.Bootstrap;
import com.sun.star.beans.PropertyValue;
import com.sun.star.container.XNameAccess;
import com.sun.star.frame.XComponentLoader;
import com.sun.star.frame.XStorable;
import com.sun.star.lang.XComponent;
import com.sun.star.sheet.XSpreadsheet;
import com.sun.star.sheet.XSpreadsheetDocument;
import com.sun.star.table.XColumnRowRange;
import com.sun.star.table.XTableRows;
import com.sun.star.uno.UnoRuntime;
import com.sun.star.uno.XComponentContext;
import com.sun.star.util.XCloseable;

/**
 * Batch row operations: args = port source-url target-url [sheet operation row count]x N.
 * Operations are applied in order with one LibreOffice session and saved once.
 * All arguments are validated before anything is applied (fail-closed).
 */
public final class RowBridge {
    private static <T> T q(Class<T> type, Object value) { return UnoRuntime.queryInterface(type, value); }
    private static PropertyValue prop(String name, Object value) {
        PropertyValue p = new PropertyValue(); p.Name = name; p.Value = value; return p;
    }
    private static final class Op {
        final String sheet, operation; final int row, count;
        Op(String s, String o, int r, int c) { sheet = s; operation = o; row = r; count = c; }
    }
    public static void main(String[] args) {
        int status = 1;
        XComponent doc = null;
        try {
            if (args.length < 7 || (args.length - 3) % 4 != 0) {
                throw new IllegalArgumentException("expected port source-url target-url [sheet operation row count]x N");
            }
            java.util.List<Op> ops = new java.util.ArrayList<>();
            java.util.Set<String> seen = new java.util.HashSet<>();
            for (int i = 3; i < args.length; i += 4) {
                String sheet = args[i], operation = args[i + 1];
                int row = Integer.parseInt(args[i + 2]), count = Integer.parseInt(args[i + 3]);
                if (row < 1 || count < 1) throw new IllegalArgumentException("row and count must be positive");
                if (!operation.equals("insert") && !operation.equals("delete")) {
                    throw new IllegalArgumentException("operation must be insert or delete");
                }
                if (!seen.add(sheet)) throw new IllegalArgumentException("multiple operations on sheet: " + sheet);
                ops.add(new Op(sheet, operation, row, count));
            }
            XComponentContext local = Bootstrap.createInitialComponentContext(null);
            Object resolver = local.getServiceManager().createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local);
            Object remote = q(XUnoUrlResolver.class, resolver).resolve("uno:socket,host=127.0.0.1,port=" + args[0] + ";urp;StarOffice.ComponentContext");
            XComponentContext context = q(XComponentContext.class, remote);
            Object desktop = context.getServiceManager().createInstanceWithContext("com.sun.star.frame.Desktop", context);
            doc = q(XComponentLoader.class, desktop).loadComponentFromURL(args[1], "_blank", 0, new PropertyValue[]{prop("Hidden", true), prop("ReadOnly", true), prop("UpdateDocMode", (short)0)});
            if (doc == null) throw new IllegalStateException("LibreOffice did not load input document");
            XSpreadsheetDocument workbook = q(XSpreadsheetDocument.class, doc);
            if (workbook == null) throw new IllegalArgumentException("input is not a spreadsheet");
            XNameAccess sheets = q(XNameAccess.class, workbook.getSheets());
            for (Op op : ops) {
                if (!sheets.hasByName(op.sheet)) throw new IllegalArgumentException("sheet not found: " + op.sheet);
            }
            for (Op op : ops) {
                XSpreadsheet sheet = q(XSpreadsheet.class, sheets.getByName(op.sheet));
                XTableRows rows = q(XColumnRowRange.class, sheet).getRows();
                if (op.operation.equals("insert")) rows.insertByIndex(op.row - 1, op.count);
                else rows.removeByIndex(op.row - 1, op.count);
            }
            q(XStorable.class, doc).storeAsURL(args[2], new PropertyValue[]{prop("FilterName", "Calc MS Excel 2007 XML"), prop("Overwrite", false)});
            q(XCloseable.class, doc).close(true); doc = null;
            System.out.println("saved " + args[2] + " ops=" + ops.size());
            status = 0;
        } catch (Throwable e) { e.printStackTrace(System.err); }
        finally { if (doc != null) try { doc.dispose(); } catch (Throwable ignored) { } }
        System.exit(status); // UNO bridge threads otherwise keep the client alive.
    }
}
