## 题目描述

用一个下标从 **0** 开始的二维整数数组 `rectangles` 来表示 `n` 个矩形，其中 `rectangles[i] = [width~i, height~i]` 表示第 `i` 个矩形的宽度和高度。

如果两个矩形 `i` 和 `j`（`i < j`）的宽高比相同，则认为这两个矩形 **可互换** 。更规范的说法是，两个矩形满足 `width~i/height~i == width~j/height~j`（使用实数除法而非整数除法），则认为这两个矩形 **可互换** 。

计算并返回 `rectangles` 中有多少对 **可互换 **矩形。

 

**示例 1：**

```
**输入：**rectangles = [[4,8],[3,6],[10,20],[15,30]]
**输出：**6
**解释：**下面按下标（从 0 开始）列出可互换矩形的配对情况：
- 矩形 0 和矩形 1 ：4/8 == 3/6
- 矩形 0 和矩形 2 ：4/8 == 10/20
- 矩形 0 和矩形 3 ：4/8 == 15/30
- 矩形 1 和矩形 2 ：3/6 == 10/20
- 矩形 1 和矩形 3 ：3/6 == 15/30
- 矩形 2 和矩形 3 ：10/20 == 15/30
```

**示例 2：**

```
**输入：**rectangles = [[4,5],[7,8]]
**输出：**0
**解释：**不存在成对的可互换矩形。
```

 

**提示：**

	- `n == rectangles.length`

	- `1 <= n <= 105`

	- `rectangles[i].length == 2`

	- `1 <= widthi, heighti <= 105`

## 解法

```java
class Solution {
    public long interchangeableRectangles(int[][] rectangles) {
        Map<String, Integer> cnt = new HashMap<>();
        long ans = 0;
        for (int[] r : rectangles) {
            int g = gcd(r[0], r[1]);           // 求最大公约数
            String key = (r[0] / g) + "/" + (r[1] / g);  // 最简分数
            int c = cnt.getOrDefault(key, 0);
            ans += c;
            cnt.put(key, c + 1);
        }
        return ans;
    }

    private int gcd(int a, int b) {
        return b == 0 ? a : gcd(b, a % b);
    }
}
```
